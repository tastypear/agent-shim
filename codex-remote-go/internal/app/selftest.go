package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type rpcMsg struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params map[string]any  `json:"params,omitempty"`
	Result any             `json:"result,omitempty"`
	Error  any             `json:"error,omitempty"`
}

func SelfTest(configPath, pane string) error {
	cfg, err := LoadConfig(configPath)
	if err != nil {
		return err
	}
	if err := ApplyGlobalPorts(cfg, RunDir()); err != nil {
		return err
	}
	log, err := NewLogger("", true)
	if err != nil {
		return err
	}
	defer log.Close()

	if _, err := EnsureLocalServices(cfg, log); err != nil {
		return err
	}
	ssh := NewRemoteSSH(cfg)
	remote := NewRemote(cfg, ssh)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := remote.Ensure(ctx, func(f string, a ...any) { log.Printf("[remote] "+f, a...) }); err != nil {
		return err
	}
	if _, err := remote.RemoteHome(ctx); err != nil {
		return err
	}
	ssh.Close()
	if err := EnsureProxy(cfg, log); err != nil {
		return err
	}

	paneID := pane + "-" + RandomHex(3)
	token, claims, err := IssueToken(cfg, paneID)
	if err != nil {
		return err
	}
	reg := NewLegacyRegistry(RunDir())
	_ = reg.Write(&LegacyEntry{
		Token: token, EnvID: claims.EnvID, Pane: paneID,
		ConfigName: cfg.Name, ConfigPath: cfg.Path,
		RemoteCWD: claims.RemoteCWD, RemoteHome: claims.RemoteHome,
		LocalHome: claims.LocalHome, WinCWD: claims.WinCWD, WinPath: claims.WinPath,
		BashExe: claims.BashExe, Env: claims.Env,
		LocalMatch: claims.LocalMatch, LocalWhitelist: claims.LocalWhitelist,
		RemoteOverride: claims.RemoteOverride, Yolo: cfg.Yolo,
	})

	fmt.Println("== 1) environment registration via cwd role ==")
	tui, msgs, err := openCWDProbe(cfg, token)
	if err != nil {
		return err
	}
	defer tui.Close()
	if err := waitEnvironmentReady(tui, msgs, claims.EnvID); err != nil {
		return err
	}
	fmt.Println("== 2) remote routing ==")
	if err := probeProcess(cfg, claims.EnvID,
		[]string{"bash", "-lc", "uname -s; echo REMOTE_HOME=$HOME"}, "remote", 90*time.Second); err != nil {
		return err
	}
	fmt.Println("== 3) local (herdr) routing ==")
	if err := probeProcess(cfg, claims.EnvID,
		[]string{"bash", "-lc", "echo LOCAL_PANE=$HERDR_PANE_ID; echo LOCAL_ENV=$HERDR_ENV"}, "local", 45*time.Second); err != nil {
		return err
	}
	fmt.Println("== 4) remote fs/* ==")
	if err := probeFSRead(cfg, claims.EnvID, "/root/.codex/skills/herdr/SKILL.md"); err != nil {
		return err
	}
	fmt.Println("OK")
	return nil
}

func openCWDProbe(cfg *Config, token string) (*WS, <-chan rpcMsg, error) {
	h := http.Header{}
	h.Set("Authorization", "Bearer "+token)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	ws, _, err := DialWS(ctx, wsURL(cfg.Ports.Proxy, "/"), DialOpts{Header: h, Timeout: 10 * time.Second})
	if err != nil {
		return nil, nil, fmt.Errorf("connect cwd role: %w", err)
	}
	msgs := startReader(ws)
	_ = ws.Write(encodeMessage(map[string]any{
		"id": 1, "method": "initialize",
		"params": map[string]any{
			"clientInfo":   map[string]any{"name": "probe", "version": "0"},
			"capabilities": map[string]any{"experimentalApi": false},
		},
	}))
	_ = ws.Write(encodeMessage(map[string]any{"method": "initialized", "params": map[string]any{}}))
	if _, err := waitMsg(msgs, func(m rpcMsg) bool { return string(m.ID) == "1" }, 15*time.Second); err != nil {
		ws.Close()
		return nil, nil, fmt.Errorf("initialize: %w", err)
	}
	return ws, msgs, nil
}

// waitEnvironmentReady polls environment/status until the app-server has
// actually connected through the proxy to the remote exec-server. "pending"
// is expected for the first few hundred milliseconds.
func waitEnvironmentReady(ws *WS, msgs <-chan rpcMsg, envID string) error {
	deadline := time.Now().Add(45 * time.Second)
	for id := 2; time.Now().Before(deadline); id++ {
		_ = ws.Write(encodeMessage(map[string]any{
			"id": id, "method": "environment/status",
			"params": map[string]any{"environmentId": envID},
		}))
		m, err := waitMsg(msgs, func(m rpcMsg) bool { return string(m.ID) == fmt.Sprint(id) }, 15*time.Second)
		if err != nil {
			return fmt.Errorf("environment/status: %w", err)
		}
		res, _ := m.Result.(map[string]any)
		status, _ := res["status"].(string)
		if status == "ready" {
			fmt.Printf("environment/status: %s\n", mustJSON(m.Result))
			return nil
		}
		if status != "pending" {
			return fmt.Errorf("environment/status: %s", mustJSON(m.Result))
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("environment did not become ready")
}

func probeProcess(cfg *Config, envID string, argv []string, label string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout+20*time.Second)
	defer cancel()
	ws, _, err := DialWS(ctx, wsURL(cfg.Ports.Proxy, "/env/"+envID), DialOpts{Timeout: 10 * time.Second})
	if err != nil {
		return fmt.Errorf("connect route role: %w", err)
	}
	defer ws.Close()
	msgs := startReader(ws)
	_ = ws.Write(encodeMessage(map[string]any{
		"id": 1, "method": "initialize",
		"params": map[string]any{"clientName": "probe"},
	}))
	if _, err := waitMsg(msgs, func(m rpcMsg) bool { return string(m.ID) == "1" }, 20*time.Second); err != nil {
		return fmt.Errorf("route initialize: %w", err)
	}
	_ = ws.Write(encodeMessage(map[string]any{"method": "initialized", "params": map[string]any{}}))
	time.Sleep(300 * time.Millisecond)

	pid := "probe-" + label + "-" + RandomHex(3)
	_ = ws.Write(encodeMessage(map[string]any{
		"id": 2, "method": "process/start",
		"params": map[string]any{
			"processId": pid, "argv": argv, "cwd": "file:///root",
			// Mirror what the real Codex client sends: without inherit:all the
			// exec-server spawns with an almost empty environment.
			"env":       map[string]any{},
			"envPolicy": map[string]any{"inherit": "all", "ignoreDefaultExcludes": true, "exclude": []any{}, "includeOnly": []any{}, "set": map[string]any{}},
			"tty":       false, "pipeStdin": false,
		},
	}))
	var stdout, stderr []string
	deadline := time.After(timeout)
	for {
		select {
		case m, ok := <-msgs:
			if !ok {
				return fmt.Errorf("[%s] connection closed before exit", label)
			}
			switch m.Method {
			case "process/output":
				chunk, _ := m.Params["chunk"].(string)
				raw, _ := base64.StdEncoding.DecodeString(chunk)
				if m.Params["stream"] == "stderr" {
					stderr = append(stderr, string(raw))
				} else {
					stdout = append(stdout, string(raw))
				}
			case "process/exited":
				fmt.Printf("[%s] EXITED exitCode=%v\n", label, m.Params["exitCode"])
				fmt.Printf("[%s] stdout=%s\n", label, joinStrings(stdout))
				if s := joinStrings(stderr); s != "" {
					fmt.Printf("[%s] stderr=%s\n", label, s)
				}
				if code, ok := m.Params["exitCode"].(float64); !ok || code != 0 {
					return fmt.Errorf("[%s] nonzero exit", label)
				}
				return nil
			}
		case <-deadline:
			return fmt.Errorf("[%s] timed out", label)
		case <-ctx.Done():
			return fmt.Errorf("[%s] context cancelled", label)
		}
	}
}

// startReader pumps decoded messages into a channel. gorilla panics on a
// repeated read after a failure, so exactly one goroutine ever reads.
func startReader(ws *WS) <-chan rpcMsg {
	ch := make(chan rpcMsg, 64)
	go func() {
		defer close(ch)
		for {
			data, err := ws.Read()
			if err != nil {
				return
			}
			var m rpcMsg
			if err := json.Unmarshal(data, &m); err != nil {
				continue
			}
			ch <- m
		}
	}()
	return ch
}

// probeFSRead checks that fs/readFile lands on the remote exec-server with a
// normalized file:// URI.
func probeFSRead(cfg *Config, envID, path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	ws, _, err := DialWS(ctx, wsURL(cfg.Ports.Proxy, "/env/"+envID), DialOpts{Timeout: 10 * time.Second})
	if err != nil {
		return fmt.Errorf("connect route role: %w", err)
	}
	defer ws.Close()
	msgs := startReader(ws)
	_ = ws.Write(encodeMessage(map[string]any{
		"id": 1, "method": "initialize", "params": map[string]any{"clientName": "probe"},
	}))
	if _, err := waitMsg(msgs, func(m rpcMsg) bool { return string(m.ID) == "1" }, 20*time.Second); err != nil {
		return fmt.Errorf("route initialize: %w", err)
	}
	_ = ws.Write(encodeMessage(map[string]any{"method": "initialized", "params": map[string]any{}}))
	// Send the Windows spelling to prove the normalization, not just passthrough.
	rel := strings.TrimPrefix(path, cfg.RemoteHome())
	winish := PathToURI(cfg.LocalHome() + rel)
	_ = ws.Write(encodeMessage(map[string]any{
		"id": 2, "method": "fs/readFile", "params": map[string]any{"path": winish},
	}))
	_ = ws.Write(encodeMessage(map[string]any{
		"id": 3, "method": "fs/readFile", "params": map[string]any{"path": PathToURI(path)},
	}))
	m, err := waitMsg(msgs, func(m rpcMsg) bool { return string(m.ID) == "2" }, 20*time.Second)
	if err != nil {
		return fmt.Errorf("fs/readFile (windows spelling): %w", err)
	}
	if m.Error != nil {
		fmt.Printf("fs/readFile windows-spelling error (see proxy log): %v\n", m.Error)
	}
	m, err = waitMsg(msgs, func(m rpcMsg) bool { return string(m.ID) == "3" }, 20*time.Second)
	if err != nil {
		return fmt.Errorf("fs/readFile (posix spelling): %w", err)
	}
	if m.Error != nil {
		return fmt.Errorf("fs/readFile posix error: %v", m.Error)
	}
	res, _ := m.Result.(map[string]any)
	data, _ := res["dataBase64"].(string)
	raw, _ := base64.StdEncoding.DecodeString(data)
	if len(raw) == 0 {
		return fmt.Errorf("fs/readFile returned no data")
	}
	fmt.Printf("fs/readFile %s -> %d bytes\n", path, len(raw))
	return nil
}

func waitMsg(msgs <-chan rpcMsg, match func(rpcMsg) bool, timeout time.Duration) (*rpcMsg, error) {
	deadline := time.After(timeout)
	for {
		select {
		case m, ok := <-msgs:
			if !ok {
				return nil, fmt.Errorf("connection closed")
			}
			if match(m) {
				return &m, nil
			}
		case <-deadline:
			return nil, fmt.Errorf("timeout")
		}
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func joinStrings(v []string) string {
	out := ""
	for _, s := range v {
		out += s
	}
	return trimSpace(out)
}
