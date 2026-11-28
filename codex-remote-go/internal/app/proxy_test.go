package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakeExecServer speaks just enough exec-server protocol to assert what the
// proxy forwarded: initialize/initialized, process/start, and an ack.
type fakeExecServer struct {
	mu       sync.Mutex
	starts   []map[string]any
	srv      *httptest.Server
	upgrader websocket.Upgrader
}

type fakeAppServer struct {
	srv      *httptest.Server
	upgrader websocket.Upgrader
}

func newFakeAppServer(t *testing.T) *fakeAppServer {
	f := &fakeAppServer{upgrader: websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := f.upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		for {
			_, data, err := c.ReadMessage()
			if err != nil {
				return
			}
			var m map[string]any
			if err := json.Unmarshal(data, &m); err != nil {
				continue
			}
			switch m["method"] {
			case "initialize":
				_ = c.WriteJSON(map[string]any{"id": m["id"], "result": map[string]any{}})
			case "environment/add", "initialized":
				if id, ok := m["id"]; ok {
					_ = c.WriteJSON(map[string]any{"id": id, "result": map[string]any{}})
				}
			}
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAppServer) wsURL() string {
	return "ws" + strings.TrimPrefix(f.srv.URL, "http")
}

func newFakeExecServer(t *testing.T) *fakeExecServer {
	f := &fakeExecServer{upgrader: websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := f.upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		for {
			_, data, err := c.ReadMessage()
			if err != nil {
				return
			}
			var m map[string]any
			if err := json.Unmarshal(data, &m); err != nil {
				continue
			}
			switch m["method"] {
			case "initialize":
				_ = c.WriteJSON(map[string]any{"id": m["id"], "result": map[string]any{"sessionId": "s"}})
			case "process/start":
				params, _ := m["params"].(map[string]any)
				f.mu.Lock()
				f.starts = append(f.starts, params)
				f.mu.Unlock()
				_ = c.WriteJSON(map[string]any{"id": m["id"], "result": map[string]any{"processId": params["processId"]}})
			}
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeExecServer) wsURL() string {
	return "ws" + strings.TrimPrefix(f.srv.URL, "http")
}

func (f *fakeExecServer) startsCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.starts)
}

func (f *fakeExecServer) last() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.starts) == 0 {
		return nil
	}
	return f.starts[len(f.starts)-1]
}

func testProxy(t *testing.T, cfg *Config, remote, win *fakeExecServer) (*Proxy, *httptest.Server) {
	t.Helper()
	log, err := NewLogger("", false)
	if err != nil {
		t.Fatal(err)
	}
	p, err := NewProxy(cfg, t.TempDir(), log)
	if err != nil {
		t.Fatal(err)
	}
	if remote != nil {
		url := remote.wsURL()
		p.dialRemoteFn = func(ctx context.Context, _ *Config) (*WS, error) {
			ws, _, err := DialWS(ctx, url, DialOpts{Timeout: 5 * time.Second})
			return ws, err
		}
	} else {
		p.dialRemoteFn = func(context.Context, *Config) (*WS, error) {
			return nil, context.DeadlineExceeded
		}
	}
	if win != nil {
		p.winURL = win.wsURL()
	}
	app := newFakeAppServer(t)
	p.upstream = app.wsURL()
	p.upNet = nil
	p.key = NewTokenKeyForTests([]byte("0123456789abcdef0123456789abcdef"))
	srv := httptest.NewServer(p.Handler())
	t.Cleanup(srv.Close)
	return p, srv
}

func testConfig(t *testing.T) *Config {
	t.Helper()
	dir := t.TempDir()
	path := dir + "/cfg.json"
	body := `{"name":"t","paths":{"vcwd":"/root","remoteHome":"/root"},
	  "codex":{"localHome":"C:\\Users\\me","exe":"C:\\nonexistent\\codex.exe"},
	  "exec":{"localMatch":["herdr ","HERDR_"],"localPath":"C:\\bin"}}`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func wsBase(srv *httptest.Server) string {
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func issueWithKey(t *testing.T, cfg *Config, key *TokenKey) (string, *Claims) {
	t.Helper()
	tok, claims, err := IssueTokenWithKey(cfg, "test-pane", key)
	if err != nil {
		t.Fatal(err)
	}
	return tok, claims
}

func TestProxyRoutesRemoteAndLocal(t *testing.T) {
	cfg := testConfig(t)
	remote := newFakeExecServer(t)
	win := newFakeExecServer(t)
	p, srv := testProxy(t, cfg, remote, win)
	token, claims := issueWithKey(t, cfg, p.key)

	h := http.Header{}
	h.Set("Authorization", "Bearer "+token)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	tui, _, err := DialWS(ctx, wsBase(srv)+"/", DialOpts{Header: h, Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer tui.Close()
	_ = tui.Write(encodeMessage(map[string]any{
		"id": 1, "method": "initialize",
		"params": map[string]any{"capabilities": map[string]any{"experimentalApi": false}},
	}))
	// The app-server only learns the env id after the cwd role sees initialize.
	time.Sleep(500 * time.Millisecond)

	route, _, err := DialWS(ctx, wsBase(srv)+"/env/"+claims.EnvID, DialOpts{Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer route.Close()
	_ = route.Write(encodeMessage(map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"clientName": "app"}}))

	time.Sleep(400 * time.Millisecond)
	_ = route.Write(encodeMessage(map[string]any{
		"id": 2, "method": "process/start",
		"params": map[string]any{
			"processId": "p-remote",
			"argv":      []any{"bash", "-lc", "uname -s"},
			"cwd":       "file:///C:/Users/me/proj",
			"env":       map[string]any{},
		},
	}))
	_ = route.Write(encodeMessage(map[string]any{
		"id": 3, "method": "process/start",
		"params": map[string]any{
			"processId": "p-local",
			"argv":      []any{"bash", "-lc", "herdr pane list"},
			"cwd":       "file:///root",
			"env":       map[string]any{},
		},
	}))
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && (remote.startsCount() < 1 || win.startsCount() < 1) {
		time.Sleep(50 * time.Millisecond)
	}
	if remote.startsCount() != 1 {
		t.Fatalf("remote starts = %d, want 1", remote.startsCount())
	}
	if win.startsCount() != 1 {
		t.Fatalf("win starts = %d, want 1", win.startsCount())
	}

	rp := remote.last()
	if rp["cwd"] != "file:///root/proj" {
		t.Errorf("remote cwd = %v, want file:///root/proj", rp["cwd"])
	}
	if argv, _ := rp["argv"].([]any); len(argv) != 3 || argv[2] != "uname -s" {
		t.Errorf("remote argv = %v", rp["argv"])
	}

	wp := win.last()
	env, _ := wp["env"].(map[string]any)
	if env["PATH"] != cfg.WinPath() {
		t.Errorf("win PATH = %v, want %v", env["PATH"], cfg.WinPath())
	}
	for k, v := range claims.Env {
		if env[k] != v {
			t.Errorf("win env %s = %v, want %v", k, env[k], v)
		}
	}
	if wp["cwd"] != PathToURI(cfg.LocalHome()) {
		t.Errorf("win cwd = %v", wp["cwd"])
	}
}

func TestProxyFailsFastWhenRemoteDown(t *testing.T) {
	cfg := testConfig(t)
	win := newFakeExecServer(t)
	p, srv := testProxy(t, cfg, nil, win)
	token, claims := issueWithKey(t, cfg, p.key)

	h := http.Header{}
	h.Set("Authorization", "Bearer "+token)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tui, _, err := DialWS(ctx, wsBase(srv)+"/", DialOpts{Header: h, Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer tui.Close()
	_ = tui.Write(encodeMessage(map[string]any{"id": 1, "method": "initialize", "params": map[string]any{}}))
	time.Sleep(500 * time.Millisecond)

	route, _, err := DialWS(ctx, wsBase(srv)+"/env/"+claims.EnvID, DialOpts{Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer route.Close()
	_ = route.Write(encodeMessage(map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"clientName": "app"}}))
	time.Sleep(300 * time.Millisecond)
	_ = route.Write(encodeMessage(map[string]any{
		"id": 9, "method": "process/start",
		"params": map[string]any{"processId": "p", "argv": []any{"bash", "-lc", "true"}, "cwd": "file:///root", "env": map[string]any{}},
	}))
	_ = route.Conn().SetReadDeadline(time.Now().Add(25 * time.Second))
	for {
		_, data, err := route.Conn().ReadMessage()
		if err != nil {
			t.Fatalf("no error reply: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		if m["id"] == float64(9) {
			if _, ok := m["error"]; !ok {
				t.Fatalf("expected error reply, got %v", m)
			}
			return
		}
	}
}

func TestProxyRejectsUnknownToken(t *testing.T) {
	cfg := testConfig(t)
	_, srv := testProxy(t, cfg, nil, nil)
	h := http.Header{}
	h.Set("Authorization", "Bearer nope")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := DialWS(ctx, wsBase(srv)+"/", DialOpts{Header: h, Timeout: 5 * time.Second})
	if err != nil {
		return
	}
	defer ws.Close()
	_ = ws.Conn().SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, rerr := ws.Conn().ReadMessage(); rerr == nil {
		t.Fatal("unknown token must not get a working session")
	}
}

// Two windows launched from the same config must not cross wires: each token
// carries its own env id, HERDR snapshot and cwd.
func TestProxyTwoPanesSameConfig(t *testing.T) {
	cfg := testConfig(t)
	remote := newFakeExecServer(t)
	win := newFakeExecServer(t)
	p, srv := testProxy(t, cfg, remote, win)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	type pane struct {
		tok    string
		claims *Claims
		tui    *WS
		route  *WS
	}
	var panes []*pane
	for _, name := range []string{"w1:p1", "w2:p1"} {
		tok, claims, err := IssueTokenWithKey(cfg, name, p.key)
		if err != nil {
			t.Fatal(err)
		}
		claims.Env = map[string]string{"HERDR_PANE_ID": name}
		// Re-encode so the env snapshot rides in the token, like a real launch.
		tok, err = p.key.Encode(claims)
		if err != nil {
			t.Fatal(err)
		}
		h := http.Header{}
		h.Set("Authorization", "Bearer "+tok)
		tui, _, err := DialWS(ctx, wsBase(srv)+"/", DialOpts{Header: h, Timeout: 5 * time.Second})
		if err != nil {
			t.Fatal(err)
		}
		_ = tui.Write(encodeMessage(map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"capabilities": map[string]any{}}}))
		panes = append(panes, &pane{tok: tok, claims: claims, tui: tui})
	}
	time.Sleep(700 * time.Millisecond)

	for _, pn := range panes {
		route, _, err := DialWS(ctx, wsBase(srv)+"/env/"+pn.claims.EnvID, DialOpts{Timeout: 5 * time.Second})
		if err != nil {
			t.Fatal(err)
		}
		pn.route = route
		_ = route.Write(encodeMessage(map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"clientName": "app"}}))
	}
	time.Sleep(400 * time.Millisecond)
	for i, pn := range panes {
		_ = pn.route.Write(encodeMessage(map[string]any{
			"id": 2, "method": "process/start",
			"params": map[string]any{
				"processId": "p" + string(rune('a'+i)),
				"argv":      []any{"bash", "-lc", "herdr pane list"},
				"cwd":       "file:///root",
				"env":       map[string]any{},
			},
		}))
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && win.startsCount() < 2 {
		time.Sleep(50 * time.Millisecond)
	}
	if win.startsCount() != 2 {
		t.Fatalf("win starts = %d, want 2", win.startsCount())
	}
	win.mu.Lock()
	got := append([]map[string]any(nil), win.starts...)
	win.mu.Unlock()
	seen := map[string]bool{}
	for _, st := range got {
		env, _ := st["env"].(map[string]any)
		id, _ := env["HERDR_PANE_ID"].(string)
		seen[id] = true
	}
	if !seen["w1:p1"] || !seen["w2:p1"] || len(seen) != 2 {
		t.Fatalf("panes cross-wired: %v", seen)
	}
	for _, pn := range panes {
		_ = pn.route.Close()
		_ = pn.tui.Close()
	}
}
