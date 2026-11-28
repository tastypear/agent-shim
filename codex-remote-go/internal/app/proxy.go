package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const connectDeadline = 8 * time.Second

type Proxy struct {
	cfg      *Config
	runDir   string
	log      *Logger
	key      *TokenKey
	configs  *ConfigCache
	tunnels  *TunnelManager
	registry *LegacyRegistry

	upstream string
	upNet    func(ctx context.Context, network, addr string) (net.Conn, error)
	win      string

	mu       sync.Mutex
	envIndex map[string]*Claims
	nextID   atomic.Int64
	liveEnv  map[string]int
	routes   map[string]map[*routeHandle]struct{}
	dialFail map[string]*dialBackoff

	// test hooks
	dialRemoteFn func(ctx context.Context, cfg *Config) (*WS, error)
	winURL       string
}

func NewProxy(cfg *Config, runDir string, log *Logger) (*Proxy, error) {
	key, err := LoadOrCreateTokenKey(runDir)
	if err != nil {
		return nil, err
	}
	p := &Proxy{
		cfg:      cfg,
		runDir:   runDir,
		log:      log,
		key:      key,
		configs:  NewConfigCache(),
		registry: NewLegacyRegistry(runDir),
		upstream: "ws://app-server/",
		upNet: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", AppServerSocketPath())
		},
		win:      wsURL(cfg.Ports.WinExecServer, "/"),
		envIndex: map[string]*Claims{},
		liveEnv:  map[string]int{},
		routes:   map[string]map[*routeHandle]struct{}{},
		dialFail: map[string]*dialBackoff{},
	}
	p.tunnels = NewTunnelManager(p.configs, log)
	return p, nil
}

func (p *Proxy) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", p.dispatch)
	mux.HandleFunc("/control/stop", p.controlStop)
	mux.HandleFunc("/healthz", p.healthz)
	return mux
}

func (p *Proxy) healthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"impl":  "codex-remote-go",
		"pid":   os.Getpid(),
		"live":  p.liveCount(),
		"proxy": p.cfg.Ports.Proxy,
	})
}

func (p *Proxy) liveCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, v := range p.liveEnv {
		n += v
	}
	return n
}

func (p *Proxy) controlStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	key, err := os.ReadFile(filepath.Join(p.runDir, "control.key"))
	if err != nil || strings.TrimSpace(r.Header.Get("X-Control-Key")) != strings.TrimSpace(string(key)) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var req struct {
		Config  string `json:"config"`
		All     bool   `json:"all"`
		DropSSH string `json:"dropSsh"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.All {
		p.tunnels.CloseAll()
		p.log.Printf("[control] closed all tunnels")
	} else if req.DropSSH != "" {
		p.tunnels.CloseConfig(req.DropSSH)
		p.log.Printf("[control] dropped ssh for %s (simulated sleep)", req.DropSSH)
	} else if req.Config != "" {
		p.tunnels.CloseConfig(req.Config)
		p.log.Printf("[control] closed tunnel for %s", req.Config)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (p *Proxy) registerRoute(key string, s *side) {
	h := &routeHandle{s: s}
	p.mu.Lock()
	m := p.routes[key]
	if m == nil {
		m = map[*routeHandle]struct{}{}
		p.routes[key] = m
	}
	m[h] = struct{}{}
	p.mu.Unlock()
}

// orphanRoute serves the exec-server handshake for an environment whose TUI is
// gone. Closing the connection would only make the app-server reconnect, so we
// answer `initialize` and fail everything else with a JSON-RPC error.
func (p *Proxy) orphanRoute(app *WS, envID string) {
	defer app.Close()
	// A proxy restart can make the app-server reconnect /env before the TUI
	// has finished reconnecting. If a TUI appears while this placeholder is
	// open, close it so the app-server retries and gets a real route.
	stopWatch := make(chan struct{})
	defer close(stopWatch)
	go func() {
		t := time.NewTicker(250 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-stopWatch:
				return
			case <-t.C:
				if p.envLive(envID) > 0 {
					_ = app.Close()
					return
				}
			}
		}
	}()
	for {
		data, err := app.Read()
		if err != nil {
			return
		}
		m, ok := decodeMessage(data)
		if !ok {
			continue
		}
		switch methodOf(m) {
		case "initialize":
			params := paramsOf(m)
			// Echo the caller's resume id: app-server refuses a response whose
			// session id differs from the one it already cached.
			sid, _ := params["resumeSessionId"].(string)
			if sid == "" {
				sid = "orphan-" + envID
			}
			_ = app.Write(encodeMessage(map[string]any{
				"id": m["id"],
				"result": map[string]any{
					"sessionId": sid,
					"environmentInfo": map[string]any{
						"shell":           map[string]any{"name": "bash", "path": "/bin/bash"},
						"executorVersion": "0.0.0",
						"platformOs":      "linux",
					},
				},
			}))
		case "initialized":
		default:
			if id, ok := m["id"]; ok {
				_ = app.Write(encodeMessage(map[string]any{
					"id":    id,
					"error": map[string]any{"code": -32000, "message": "no live TUI for this environment; relaunch codex-remote"},
				}))
			}
		}
	}
}

func (p *Proxy) envLive(envID string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.liveEnv[envID]
}

func (p *Proxy) waitLive(envID string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if p.envLive(envID) > 0 {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return p.envLive(envID) > 0
}

func (p *Proxy) unregisterRoute(key string, s *side) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for h := range p.routes[key] {
		if h.s == s {
			delete(p.routes[key], h)
		}
	}
	if len(p.routes[key]) == 0 {
		delete(p.routes, key)
	}
}

// dropRouteRemotes closes the exec-server legs for one env while leaving the
// app-server connection open, so an idle config costs nothing but a dead
// socket the app-server will not spin on.
func (p *Proxy) dropRouteRemotes(envID string) {
	p.mu.Lock()
	handles := make([]*routeHandle, 0, len(p.routes[envID]))
	for h := range p.routes[envID] {
		handles = append(handles, h)
	}
	p.mu.Unlock()
	for _, h := range handles {
		h.s.mu.Lock()
		remote, win := h.s.remote, h.s.win
		h.s.remote, h.s.win = nil, nil
		h.s.detached = true
		h.s.mu.Unlock()
		if remote != nil {
			_ = remote.Close()
		}
		if win != nil {
			_ = win.Close()
		}
	}
}

func (p *Proxy) dispatch(w http.ResponseWriter, r *http.Request) {
	if !websocket.IsWebSocketUpgrade(r) {
		_, _ = w.Write([]byte("codex-remote proxy\n"))
		return
	}
	up := websocket.Upgrader{
		ReadBufferSize:  64 << 10,
		WriteBufferSize: 64 << 10,
		CheckOrigin:     func(*http.Request) bool { return true },
	}
	conn, err := up.Upgrade(w, r, nil)
	if err != nil {
		p.log.Printf("[proxy] upgrade failed: %v", err)
		return
	}
	ws := WrapWS(conn)
	if strings.HasPrefix(r.URL.Path, "/env/") {
		p.routeRole(ws, r)
		return
	}
	p.cwdRole(ws, r)
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

func (p *Proxy) resolveFromToken(token string) (*Runtime, error) {
	if token == "" {
		return nil, errors.New("no token")
	}
	if cl, err := p.key.Decode(token); err == nil {
		cfg, err := p.configs.Load(cl.ConfigPath)
		if err != nil {
			return nil, fmt.Errorf("token config %s: %w", cl.ConfigPath, err)
		}
		rt := RuntimeFromConfig(cfg, cl)
		rt.Token = token
		return rt, nil
	}
	// Legacy registry entries from the Python implementation.
	if e := p.registry.ByToken(token); e != nil {
		cfg, err := p.configs.Load(e.ConfigPath)
		if err != nil {
			return nil, fmt.Errorf("legacy token config %s: %w", e.ConfigPath, err)
		}
		rt := RuntimeFromConfig(cfg, e.claims())
		rt.Token = token
		return rt, nil
	}
	return nil, errors.New("unrecognized token")
}

func (p *Proxy) resolveFromEnvID(envID string, r *http.Request) (*Runtime, error) {
	if tok := BearerToken(r.Header.Get("Authorization")); tok != "" {
		if rt, err := p.resolveFromToken(tok); err == nil {
			return rt, nil
		}
	}
	// The app-server can open the environment connection before the TUI's
	// initialize has been processed on the cwd side; give the index a moment.
	for i := 0; i < 20; i++ {
		p.mu.Lock()
		cl := p.envIndex[envID]
		p.mu.Unlock()
		if cl != nil {
			cfg, err := p.configs.Load(cl.ConfigPath)
			if err != nil {
				return nil, err
			}
			return RuntimeFromConfig(cfg, cl), nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	if e := p.registry.ByEnvID(envID); e != nil {
		cfg, err := p.configs.Load(e.ConfigPath)
		if err != nil {
			return nil, err
		}
		return RuntimeFromConfig(cfg, e.claims()), nil
	}
	return nil, fmt.Errorf("unknown environment %s", envID)
}

func (e *LegacyEntry) claims() *Claims {
	yolo := true
	return &Claims{
		ConfigPath:     e.ConfigPath,
		ConfigName:     e.ConfigName,
		Pane:           e.Pane,
		EnvID:          e.EnvID,
		RemoteCWD:      e.RemoteCWD,
		RemoteHome:     e.RemoteHome,
		LocalHome:      e.LocalHome,
		WinCWD:         e.WinCWD,
		WinPath:        e.WinPath,
		BashExe:        e.BashExe,
		Env:            e.Env,
		LocalMatch:     e.LocalMatch,
		LocalWhitelist: e.LocalWhitelist,
		RemoteOverride: e.RemoteOverride,
		Yolo:           &yolo,
	}
}

// ---------------------------------------------------------------------------
// cwd role (TUI side)
// ---------------------------------------------------------------------------

func (p *Proxy) cwdRole(tui *WS, r *http.Request) {
	token := BearerToken(r.Header.Get("Authorization"))
	rt, err := p.resolveFromToken(token)
	if err != nil {
		p.log.Printf("[cwd] rejected: %v", err)
		_ = tui.Close()
		return
	}
	p.log.Printf("[cwd] TUI pane=%s env=%s config=%s", rt.Pane, rt.EnvID(), rt.Name())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	up, _, err := DialWS(ctx, p.upstream, DialOpts{
		Timeout: 10 * time.Second,
		NetDial: p.upNet,
	})
	if err != nil {
		p.log.Printf("[cwd] upstream %s (unix:%s): %v", p.upstream, AppServerSocketPath(), err)
		_ = tui.Close()
		return
	}
	defer up.Close()

	// A live TUI connection is what keeps this config's SSH tunnel alive; the
	// app-server's environment connections deliberately do not (they reconnect
	// forever otherwise).
	p.mu.Lock()
	p.liveEnv[rt.EnvID()]++
	p.envIndex[rt.EnvID()] = rt.Claims
	// Prune entries whose TUI is long gone so a long-lived proxy does not grow
	// without bound.
	if len(p.envIndex) > 256 {
		for id := range p.envIndex {
			if _, live := p.liveEnv[id]; !live {
				delete(p.envIndex, id)
			}
		}
	}
	p.mu.Unlock()
	if _, err := p.tunnels.Acquire(rt.Config); err == nil {
		defer p.tunnels.Release(rt.Config)
	}
	defer func() {
		p.mu.Lock()
		p.liveEnv[rt.EnvID()]--
		if p.liveEnv[rt.EnvID()] <= 0 {
			delete(p.liveEnv, rt.EnvID())
		}
		p.mu.Unlock()
		// Drop the remote leg (and with it the SSH channel) but keep the
		// app-server's environment connection: closing that only makes the
		// app-server reconnect in a loop.
		p.dropRouteRemotes(rt.EnvID())
	}()

	var upMu sync.Mutex
	sendUp := func(b []byte) error {
		upMu.Lock()
		defer upMu.Unlock()
		return up.Write(b)
	}

	done := make(chan struct{})
	initReply := make(chan struct{}, 1)
	var initMu sync.Mutex
	initID := ""
	go func() {
		defer close(done)
		for {
			data, err := up.Read()
			if err != nil {
				_ = tui.Close()
				return
			}
			if id, ok := idString(data); ok && strings.HasPrefix(id, "cr-add-") {
				if p.cfg.Proxy.Debug {
					p.log.Printf("[cwd] environment/add response: %s", truncate(string(data), 400))
				}
				continue
			}
			initMu.Lock()
			want := initID
			initMu.Unlock()
			if want != "" {
				if id, ok := idString(data); ok && id == want {
					select {
					case initReply <- struct{}{}:
					default:
					}
				}
			}
			if err := tui.Write(data); err != nil {
				_ = up.Close()
				return
			}
		}
	}()

	sentAdd := false
	for {
		data, err := tui.Read()
		if err != nil {
			break
		}
		m, ok := decodeMessage(data)
		if !ok {
			if err := sendUp(data); err != nil {
				break
			}
			continue
		}
		method := methodOf(m)
		if method == "initialize" && !sentAdd {
			sentAdd = true
			ensureExperimental(m)
			id, _ := rawID(m)
			initMu.Lock()
			initID = id
			initMu.Unlock()
			if err := sendUp(encodeMessage(m)); err != nil {
				break
			}
			// environment/add before the initialize response is rejected with
			// "Not initialized" by newer app-servers; wait for it.
			if id != "" {
				select {
				case <-initReply:
				case <-time.After(20 * time.Second):
					p.log.Printf("[cwd] initialize reply timed out; sending add anyway")
				}
			}
			add := map[string]any{
				"id":     fmt.Sprintf("cr-add-%d", p.nextID.Add(1)),
				"method": "environment/add",
				"params": map[string]any{
					"environmentId":    rt.EnvID(),
					"execServerUrl":    wsURL(p.cfg.Ports.Proxy, "/env/"+rt.EnvID()),
					"authBearerToken":  rt.Token,
					"connectTimeoutMs": 15000,
				},
			}
			if err := sendUp(encodeMessage(add)); err != nil {
				break
			}
			p.log.Printf("[cwd] environment/add env=%s pane=%s", rt.EnvID(), rt.Pane)
			continue
		}
		applyCWDInjection(rt, method, paramsOf(m))
		if p.cfg.Proxy.Debug {
			p.log.Printf("[cwd] %s -> %s", method, truncate(string(encodeMessage(m)), 4000))
		}
		if err := sendUp(encodeMessage(m)); err != nil {
			break
		}
	}
	cancel()
	_ = up.Close()
	_ = tui.Close()
	<-done
}

func idString(raw []byte) (string, bool) {
	var v struct {
		ID json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(raw, &v); err != nil || len(v.ID) == 0 {
		return "", false
	}
	var s string
	if err := json.Unmarshal(v.ID, &s); err == nil {
		return s, true
	}
	return string(v.ID), true
}

func rawID(m map[string]any) (string, bool) {
	id, ok := m["id"]
	if !ok {
		return "", false
	}
	return fmt.Sprint(id), true
}

func methodOf(m map[string]any) string {
	s, _ := m["method"].(string)
	return s
}

func paramsOf(m map[string]any) map[string]any {
	p, _ := m["params"].(map[string]any)
	if p == nil {
		p = map[string]any{}
		m["params"] = p
	}
	return p
}

// ---------------------------------------------------------------------------
// route role (app-server side)
// ---------------------------------------------------------------------------

type side struct {
	app    *WS
	mu     sync.Mutex
	remote *WS
	win    *WS
	winCh  chan *WS
	// detached is set when the remote leg is dropped on purpose (TUI exited).
	// The remote reader must then not close the app-server connection.
	detached bool
	dialing  bool
	dialDone chan struct{}
}

type routeHandle struct {
	s *side
}

type dialBackoff struct {
	failures int
	next     time.Time
}

// allowDial throttles redials after a failure. Without it a 60 s outage
// produces dozens of SSH connects because every app-server retry re-dials.
func (p *Proxy) allowDial(cfg *Config) bool {
	p.mu.Lock()
	b := p.dialFail[cfg.Key]
	if b == nil {
		p.mu.Unlock()
		return true
	}
	if time.Now().After(b.next) {
		p.mu.Unlock()
		return true
	}
	p.mu.Unlock()
	// Still cooling down. If the host is reachable again, don't make the user
	// wait out the backoff: probe once and clear it.
	if cfg.SocksProxy() != "" {
		return false
	}
	conn, err := net.DialTimeout("tcp",
		net.JoinHostPort(cfg.SSH.Host, fmt.Sprintf("%d", cfg.SSH.Port)), 1500*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	p.mu.Lock()
	delete(p.dialFail, cfg.Key)
	p.mu.Unlock()
	return true
}

func (p *Proxy) noteDial(key string, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err == nil {
		delete(p.dialFail, key)
		return
	}
	b := p.dialFail[key]
	if b == nil {
		b = &dialBackoff{}
		p.dialFail[key] = b
	}
	b.failures++
	wait := time.Duration(1<<minInt(b.failures-1, 3)) * time.Second
	if wait > 30*time.Second {
		// Long outages stop hammering entirely; a TUI keystroke still gets one
		// attempt per 30s until the link is back.
		wait = 30 * time.Second
	}
	b.next = time.Now().Add(wait)
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (s *side) writeRemote(b []byte) error {
	s.mu.Lock()
	w := s.remote
	s.mu.Unlock()
	if w == nil {
		return errors.New("no remote connection")
	}
	return w.Write(b)
}

func (s *side) writeWin(b []byte) error {
	s.mu.Lock()
	w := s.win
	s.mu.Unlock()
	if w == nil {
		return errors.New("no windows connection")
	}
	return w.Write(b)
}

func (s *side) setRemote(w *WS) {
	s.mu.Lock()
	s.remote = w
	s.mu.Unlock()
}

func (s *side) dropRemote(w *WS) {
	s.mu.Lock()
	if s.remote == w {
		s.remote = nil
	}
	s.mu.Unlock()
}

func (s *side) remoteConn() *WS {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.remote
}

func (p *Proxy) routeRole(app *WS, r *http.Request) {
	envID := strings.TrimPrefix(r.URL.Path, "/env/")
	envID = strings.Trim(envID, "/")
	if i := strings.IndexByte(envID, '/'); i >= 0 {
		envID = envID[:i]
	}
	rt, err := p.resolveFromEnvID(envID, r)
	if err != nil {
		p.log.Printf("[route] unknown env %q: %v", envID, err)
		_ = app.Close()
		return
	}
	p.log.Printf("[route] app-server env=%s pane=%s config=%s", envID, rt.Pane, rt.Name())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	s := &side{app: app, winCh: make(chan *WS, 1)}
	p.registerRoute(envID, s)
	defer p.unregisterRoute(envID, s)
	if p.envLive(envID) == 0 && !p.waitLive(envID, 3*time.Second) {
		// The environment outlived its TUI. Answer its handshake locally so the
		// app-server stops reconnecting, but never rebuild SSH for it.
		p.log.Printf("[route] env=%s has no live TUI; serving as orphan", envID)
		p.orphanRoute(app, envID)
		return
	}
	go p.ensureRouteConn(ctx, rt, s)
	go p.connectWin(ctx, s)

	router := NewRouter(rt)
	mapper := rt.Mapper()
	pending := &pendingMap{m: map[string]string{}}

	for {
		data, err := app.Read()
		if err != nil {
			break
		}
		m, ok := decodeMessage(data)
		if !ok {
			if err := s.writeRemote(data); err != nil {
				p.replyError(app, nil, "remote exec-server unavailable")
			}
			continue
		}
		method := methodOf(m)
		params := paramsOf(m)

		switch {
		case method == "process/start":
			argv := stringSlice(params["argv"])
			pid := procID(params)
			if p.cfg.Proxy.Debug {
				p.log.Printf("[route] process/start params=%s", mustJSON(params))
			}
			if router.Target(argv) == "local" {
				p.log.Printf("[route] process/start -> LOCAL %v", argv)
				if !p.waitWin(ctx, s) {
					p.replyError(app, m, "local exec-server not ready")
					continue
				}
				rewriteForWin(rt, mapper, params)
				if err := s.writeWin(encodeMessage(m)); err != nil {
					p.replyError(app, m, "local exec-server send failed")
					continue
				}
				pending.set(pid, "local")
				continue
			}
			p.log.Printf("[route] process/start -> REMOTE %v", argv)
			if !p.ensureRouteConn(ctx, rt, s) {
				p.replyError(app, m, "remote exec-server unavailable")
				continue
			}
			rewriteForRemote(rt, mapper, params)
			if err := s.writeRemote(encodeMessage(m)); err != nil {
				p.replyError(app, m, "remote exec-server send failed")
				continue
			}
			pending.set(pid, "remote")

		case strings.HasPrefix(method, "process/"):
			if pending.get(procID(params)) == "local" {
				if err := s.writeWin(data); err != nil {
					p.replyError(app, m, "local exec-server unavailable")
				}
				continue
			}
			if !p.ensureRouteConn(ctx, rt, s) {
				p.replyError(app, m, "remote exec-server unavailable")
				continue
			}
			_ = s.writeRemote(data)

		case strings.HasPrefix(method, "fs/"):
			rewriteForRemote(rt, mapper, params)
			if !p.ensureRouteConn(ctx, rt, s) {
				p.replyError(app, m, "remote exec-server unavailable")
				continue
			}
			_ = s.writeRemote(encodeMessage(m))

		default:
			if !p.ensureRouteConn(ctx, rt, s) {
				p.replyError(app, m, "remote exec-server unavailable")
				continue
			}
			_ = s.writeRemote(data)
		}
	}

	cancel()
	_ = app.Close()
	s.mu.Lock()
	remote, win := s.remote, s.win
	s.remote, s.win = nil, nil
	s.mu.Unlock()
	if remote != nil {
		_ = remote.Close()
	}
	if win != nil {
		_ = win.Close()
	}
}

func (p *Proxy) connectWin(ctx context.Context, s *side) {
	ws, err := p.dialWinExec(ctx)
	if err != nil {
		p.log.Printf("[route] windows exec-server unavailable: %v", err)
		close(s.winCh)
		return
	}
	s.mu.Lock()
	s.win = ws
	s.mu.Unlock()
	s.winCh <- ws
	p.log.Printf("[route] windows exec-server connected")
	for {
		data, e := ws.Read()
		if e != nil {
			return
		}
		if e := s.app.Write(data); e != nil {
			return
		}
	}
}

func (p *Proxy) waitWin(ctx context.Context, s *side) bool {
	s.mu.Lock()
	ok := s.win != nil
	s.mu.Unlock()
	if ok {
		return true
	}
	select {
	case _, open := <-s.winCh:
		if !open {
			return false
		}
		s.mu.Lock()
		ok = s.win != nil
		s.mu.Unlock()
		return ok
	case <-time.After(8 * time.Second):
		return false
	case <-ctx.Done():
		return false
	}
}

func (p *Proxy) dialRemote(ctx context.Context, cfg *Config) (*WS, error) {
	if p.dialRemoteFn != nil {
		return p.dialRemoteFn(ctx, cfg)
	}
	t := p.tunnels.Get(cfg)
	addr := t.ExecAddr()
	dctx, cancel := context.WithTimeout(ctx, connectDeadline)
	defer cancel()
	ws, _, err := DialWS(dctx, "ws://exec-server/", DialOpts{
		Timeout: connectDeadline,
		NetDial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return t.Dial(ctx, addr)
		},
	})
	if err != nil {
		return nil, err
	}
	return ws, nil
}

// ensureRouteConn dials the remote exec-server for one app-server environment.
// Unlike ensureRemote it never runs install/start: those are launcher-time
// operations, and the TUI reconnect budget is only 120s.
func (p *Proxy) ensureRouteConn(ctx context.Context, rt *Runtime, s *side) bool {
	s.mu.Lock()
	if s.remote != nil {
		s.mu.Unlock()
		return true
	}
	if s.dialing {
		ch := s.dialDone
		s.mu.Unlock()
		// A dial is already in flight (started when the environment connected);
		// wait for it instead of failing a request that raced the handshake.
		select {
		case <-ch:
		case <-ctx.Done():
			return false
		case <-time.After(connectDeadline):
		}
		s.mu.Lock()
		ok := s.remote != nil
		s.mu.Unlock()
		return ok
	}
	s.dialing = true
	s.dialDone = make(chan struct{})
	done := s.dialDone
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.dialing = false
		s.mu.Unlock()
		close(done)
	}()
	p.mu.Lock()
	live := p.liveEnv[rt.EnvID()]
	p.mu.Unlock()
	if live == 0 {
		// No TUI is attached to this environment: stop redialing so an SSH
		// client is not resurrected after the launcher closed it.
		return false
	}
	if !p.allowDial(rt.Config) {
		return false
	}
	ws, err := p.dialRemote(ctx, rt.Config)
	p.noteDial(rt.Config.Key, err)
	if err != nil {
		p.log.Printf("[route] remote dial failed: %v", err)
		// Drop the environment connection: app-server then retries with its own
		// backoff and re-sends initialize(resumeSessionId) when the network is
		// back. Keeping a "failed" connection would wedge the turn.
		// Delay slightly so the JSON-RPC error can still be delivered first.
		time.AfterFunc(2*time.Second, func() { _ = s.app.Close() })
		return false
	}
	if p.envLive(rt.EnvID()) == 0 {
		// The TUI exited while this dial was in flight. Do not resurrect a
		// tunnel for an environment nobody is attached to.
		_ = ws.Close()
		return false
	}
	s.setRemote(ws)
	s.mu.Lock()
	s.detached = false
	s.mu.Unlock()
	go func() {
		for {
			data, e := ws.Read()
			if e != nil {
				s.dropRemote(ws)
				s.mu.Lock()
				detached := s.detached
				s.mu.Unlock()
				if detached {
					_ = ws.Close()
					return
				}
				// Let the app-server reconnect: it re-sends initialize with
				// resumeSessionId and re-reads output that piled up. Keeping
				// this connection alive instead would stall the turn, because
				// the exec-server does not replay missed notifications.
				_ = s.app.Close()
				return
			}
			if e := s.app.Write(data); e != nil {
				s.dropRemote(ws)
				_ = ws.Close()
				return
			}
		}
	}()
	return true
}

func (p *Proxy) dialWinExec(ctx context.Context) (*WS, error) {
	dctx, cancel := context.WithTimeout(ctx, connectDeadline)
	defer cancel()
	target := p.win
	if p.winURL != "" {
		target = p.winURL
	}
	ws, _, err := DialWS(dctx, target, DialOpts{Timeout: connectDeadline})
	if err != nil {
		return nil, err
	}
	initID := "cr-win-init"
	initMsg := map[string]any{
		"id":     initID,
		"method": "initialize",
		"params": map[string]any{"clientName": "codex-remote-proxy"},
	}
	if err := ws.Write(encodeMessage(initMsg)); err != nil {
		_ = ws.Close()
		return nil, err
	}
	deadline := time.Now().Add(connectDeadline)
	for time.Now().Before(deadline) {
		data, err := ws.Read()
		if err != nil {
			_ = ws.Close()
			return nil, err
		}
		m, ok := decodeMessage(data)
		if ok && fmt.Sprint(m["id"]) == initID {
			_ = ws.Write(encodeMessage(map[string]any{"method": "initialized", "params": map[string]any{}}))
			return ws, nil
		}
	}
	_ = ws.Close()
	return nil, errors.New("windows exec-server initialize timed out")
}

func (p *Proxy) replyError(ws *WS, m map[string]any, msg string) {
	if m == nil {
		return
	}
	id, ok := m["id"]
	if !ok {
		return
	}
	_ = ws.Write(encodeMessage(map[string]any{
		"id":    id,
		"error": map[string]any{"code": -32000, "message": msg},
	}))
	p.log.Printf("[route] -> app error id=%v: %s", id, msg)
}

// ---------------------------------------------------------------------------
// per-method rewrites
// ---------------------------------------------------------------------------

func rewriteForRemote(rt *Runtime, m *Mapper, params map[string]any) {
	if v, ok := params["cwd"].(string); ok && v != "" {
		params["cwd"] = m.ToPosixURI(v)
	} else {
		params["cwd"] = PathToURI(rt.RemoteCWD)
	}
	if argv, ok := params["argv"].([]any); ok {
		params["argv"] = MapStrings(argv, m.ToPosix)
	}
	if v, ok := params["sandbox"]; ok {
		params["sandbox"] = MapValue(v, m.ToPosix)
	}
	if v, ok := params["envPolicy"]; ok {
		params["envPolicy"] = MapValue(v, m.ToPosix)
	}
	for _, k := range []string{"path", "paths", "sourcePath", "destinationPath"} {
		switch v := params[k].(type) {
		case string:
			params[k] = m.ToPosixURI(v)
		case []any:
			params[k] = MapStrings(v, m.ToPosixURI)
		}
	}
	if v, ok := params["missing"].([]any); ok {
		params["missing"] = MapStrings(v, m.ToPosixURI)
	}
	if v, ok := params["present"].(string); ok {
		params["present"] = m.ToPosixURI(v)
	}
}

func rewriteForWin(rt *Runtime, m *Mapper, params map[string]any) {
	params["cwd"] = PathToURI(rt.WinCWD)
	if argv, ok := params["argv"].([]any); ok {
		out := MapStrings(argv, m.ToWin)
		if len(out) > 0 {
			if s, _ := out[0].(string); isShell(s) {
				out[0] = rt.BashExe
			}
		}
		params["argv"] = out
	}
	if v, ok := params["sandbox"]; ok {
		params["sandbox"] = MapValue(v, m.ToWin)
	}
	env, _ := params["env"].(map[string]any)
	if env == nil {
		env = map[string]any{}
		params["env"] = env
	}
	if rt.WinPath != "" {
		env["PATH"] = rt.WinPath
	}
	for k, v := range rt.Env {
		env[k] = v
	}
}

func isShell(p string) bool {
	p = strings.ToLower(strings.ReplaceAll(p, `\`, "/"))
	base := p
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		base = p[i+1:]
	}
	switch base {
	case "bash", "bash.exe", "sh", "sh.exe", "zsh", "zsh.exe", "dash":
		return true
	}
	return false
}

func stringSlice(v any) []string {
	arr, _ := v.([]any)
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func procID(params map[string]any) string {
	for _, k := range []string{"processId", "process_id"} {
		if v, ok := params[k]; ok {
			switch t := v.(type) {
			case string:
				return t
			case float64:
				return fmt.Sprintf("%.0f", t)
			}
		}
	}
	return ""
}

type pendingMap struct {
	mu sync.Mutex
	m  map[string]string
}

func (p *pendingMap) set(id, side string) {
	if id == "" {
		return
	}
	p.mu.Lock()
	p.m[id] = side
	p.mu.Unlock()
}

func (p *pendingMap) get(id string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.m[id]
}

// ---------------------------------------------------------------------------
// tunnel manager
// ---------------------------------------------------------------------------

type tunnelEntry struct {
	cfg   *Config
	ssh   *RemoteSSH
	refs  int
	timer *time.Timer
	mu    sync.Mutex
}

type TunnelManager struct {
	mu      sync.Mutex
	entries map[string]*tunnelEntry
	configs *ConfigCache
	log     *Logger
}

func NewTunnelManager(cfgc *ConfigCache, log *Logger) *TunnelManager {
	return &TunnelManager{entries: map[string]*tunnelEntry{}, configs: cfgc, log: log}
}

func (tm *TunnelManager) Acquire(cfg *Config) (*tunnelEntry, error) {
	e := tm.Get(cfg)
	e.mu.Lock()
	e.refs++
	if e.timer != nil {
		e.timer.Stop()
		e.timer = nil
	}
	e.mu.Unlock()
	return e, nil
}

// Get returns the config's tunnel entry without changing its reference count.
func (tm *TunnelManager) Get(cfg *Config) *tunnelEntry {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	e, ok := tm.entries[cfg.Key]
	if !ok {
		e = &tunnelEntry{cfg: cfg, ssh: NewRemoteSSH(cfg)}
		tm.entries[cfg.Key] = e
	}
	return e
}

func (tm *TunnelManager) Release(cfg *Config) {
	tm.mu.Lock()
	e, ok := tm.entries[cfg.Key]
	tm.mu.Unlock()
	if !ok {
		return
	}
	e.mu.Lock()
	e.refs--
	if e.refs > 0 {
		e.mu.Unlock()
		return
	}
	grace := cfg.IdleGrace()
	e.timer = time.AfterFunc(grace, func() {
		tm.mu.Lock()
		cur, ok := tm.entries[cfg.Key]
		if ok && cur == e {
			e.mu.Lock()
			idle := e.refs <= 0
			e.mu.Unlock()
			if idle {
				delete(tm.entries, cfg.Key)
				tm.mu.Unlock()
				tm.log.Printf("[tunnel] idle %s for %s; closing ssh", cfg.Name, grace)
				e.ssh.Close()
				return
			}
		}
		tm.mu.Unlock()
	})
	e.mu.Unlock()
}

func (e *tunnelEntry) Dial(ctx context.Context, addr string) (net.Conn, error) {
	return e.ssh.DialTCP(ctx, addr)
}

func (e *tunnelEntry) ExecAddr() string {
	return fmt.Sprintf("127.0.0.1:%d", e.cfg.Ports.RemoteExecServer)
}

func (tm *TunnelManager) EnsureRemote(ctx context.Context, cfg *Config, log *Logger) error {
	e := tm.Get(cfg)
	r := NewRemote(cfg, e.ssh)
	return r.Ensure(ctx, func(f string, a ...any) { log.Printf("[remote] "+f, a...) })
}

func (tm *TunnelManager) CloseAll() {
	tm.mu.Lock()
	entries := tm.entries
	tm.entries = map[string]*tunnelEntry{}
	tm.mu.Unlock()
	for _, e := range entries {
		if e.timer != nil {
			e.timer.Stop()
		}
		e.ssh.Close()
	}
}

func (tm *TunnelManager) CloseConfig(name string) {
	tm.mu.Lock()
	var closeList []*tunnelEntry
	for k, e := range tm.entries {
		if e.cfg.Name == name {
			delete(tm.entries, k)
			closeList = append(closeList, e)
		}
	}
	tm.mu.Unlock()
	for _, e := range closeList {
		if e.timer != nil {
			e.timer.Stop()
		}
		e.ssh.Close()
	}
}

// ---------------------------------------------------------------------------
// legacy registry (read/write compatibility with the Python tools)
// ---------------------------------------------------------------------------

type LegacyEntry struct {
	Token          string            `json:"token"`
	EnvID          string            `json:"envId"`
	Pane           string            `json:"pane"`
	ConfigName     string            `json:"configName"`
	ConfigPath     string            `json:"configPath"`
	RemoteCWD      string            `json:"remoteCwd"`
	RemoteHome     string            `json:"remoteHome"`
	LocalHome      string            `json:"localHome"`
	WinCWD         string            `json:"winCwd"`
	WinPath        string            `json:"winPath"`
	BashExe        string            `json:"bashExe"`
	Env            map[string]string `json:"herdr"`
	LocalMatch     []string          `json:"localMatch"`
	LocalWhitelist []string          `json:"localWhitelist"`
	RemoteOverride []string          `json:"remoteOverride"`
	TunnelURL      string            `json:"tunnelUrl"`
	Yolo           bool              `json:"yolo"`
	TuiPID         int               `json:"tuiPid,omitempty"`
}

type LegacyRegistry struct {
	dir string
}

func NewLegacyRegistry(runDir string) *LegacyRegistry {
	return &LegacyRegistry{dir: runDir + string(os.PathSeparator) + "registry"}
}

func (r *LegacyRegistry) load() []*LegacyEntry {
	ents, err := os.ReadDir(r.dir)
	if err != nil {
		return nil
	}
	var out []*LegacyEntry
	for _, de := range ents {
		if de.IsDir() || !strings.HasSuffix(de.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(r.dir + string(os.PathSeparator) + de.Name())
		if err != nil {
			continue
		}
		var e LegacyEntry
		if err := json.Unmarshal(data, &e); err != nil {
			continue
		}
		if e.ConfigPath == "" {
			e.ConfigPath = resolveLegacyConfigPath(e.ConfigName)
		}
		if e.ConfigPath == "" {
			continue
		}
		out = append(out, &e)
	}
	return out
}

// resolveLegacyConfigPath lets entries written by the Python launcher (which
// stored only configName) work without a registry migration.
func resolveLegacyConfigPath(name string) string {
	if name == "" {
		return ""
	}
	run := RunDir()
	for _, dir := range []string{
		filepath.Dir(run),
		filepath.Dir(filepath.Dir(run)),
	} {
		cand := filepath.Join(dir, ".agent-shim-codex-"+name+"-ssh.json")
		if st, err := os.Stat(cand); err == nil && !st.IsDir() {
			return cand
		}
	}
	return ""
}

func (r *LegacyRegistry) ByToken(tok string) *LegacyEntry {
	for _, e := range r.load() {
		if e.Token == tok {
			return e
		}
	}
	return nil
}

func (r *LegacyRegistry) ByEnvID(id string) *LegacyEntry {
	for _, e := range r.load() {
		if e.EnvID == id {
			return e
		}
	}
	return nil
}

func (r *LegacyRegistry) Write(e *LegacyEntry) error {
	if err := os.MkdirAll(r.dir, 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	// The self-describing token can exceed Windows' 255-char filename limit, so
	// name registry files by the (fixed-length) env id instead.
	if err := os.WriteFile(r.dir+string(os.PathSeparator)+e.EnvID+".json", data, 0o644); err != nil {
		return err
	}
	r.prune(e.ConfigName, 128)
	return nil
}

// prune keeps the registry from growing without bound. Entries are only used
// for status/stop bookkeeping, so dropping the oldest is safe.
func (r *LegacyRegistry) prune(configName string, keep int) {
	ents, err := os.ReadDir(r.dir)
	if err != nil || len(ents) <= keep {
		return
	}
	type item struct {
		name string
		mod  time.Time
	}
	var items []item
	for _, de := range ents {
		if de.IsDir() || !strings.HasSuffix(de.Name(), ".json") {
			continue
		}
		info, err := de.Info()
		if err != nil {
			continue
		}
		items = append(items, item{de.Name(), info.ModTime()})
	}
	if len(items) <= keep {
		return
	}
	sort.Slice(items, func(i, j int) bool { return items[i].mod.Before(items[j].mod) })
	for _, it := range items[:len(items)-keep] {
		_ = os.Remove(r.dir + string(os.PathSeparator) + it.name)
	}
}

// UpdateTuiPID rewrites only the pid field, so concurrent pane launches that
// share a config cannot clobber each other's entries.
func (r *LegacyRegistry) UpdateTuiPID(token string, pid int) error {
	for _, e := range r.load() {
		if e.Token != token {
			continue
		}
		e.TuiPID = pid
		return r.Write(e)
	}
	return nil
}
