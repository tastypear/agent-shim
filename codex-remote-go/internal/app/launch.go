package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"time"
)

type LaunchOptions struct {
	ConfigPath string
	Args       []string
	NoTUI      bool
}

// Launch assembles the stack, then runs one TUI. The long-lived proxy is a
// singleton detached from any launcher, so every pane (and every config)
// shares it; the launcher itself only lives as long as its TUI.
func Launch(opts LaunchOptions) error {
	cfg, err := LoadConfig(opts.ConfigPath)
	if err != nil {
		return err
	}
	if err := ApplyGlobalPorts(cfg, RunDir()); err != nil {
		return err
	}
	runDir := filepath.Join(RunDir(), cfg.Name)
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		return err
	}
	log, err := NewLogger(filepath.Join(runDir, "launcher.log"), false)
	if err != nil {
		return err
	}
	defer log.Close()
	log.Printf("config=%s name=%s ports app=%d proxy=%d win=%d remote=%d",
		cfg.Path, cfg.Name, cfg.Ports.AppServer, cfg.Ports.Proxy,
		cfg.Ports.WinExecServer, cfg.Ports.RemoteExecServer)

	exe, err := EnsureLocalServices(cfg, log)
	if err != nil {
		return err
	}
	cfg.Codex.Exe = exe

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	ssh := NewRemoteSSH(cfg)
	remote := NewRemote(cfg, ssh)
	if err := remote.Ensure(ctx, func(f string, a ...any) { log.Printf("[remote] "+f, a...) }); err != nil {
		cancel()
		return err
	}
	if home, err := remote.RemoteHome(ctx); err == nil {
		cfg.Paths.RemoteHome = home
	}
	if err := remote.SyncSkills(ctx, func(f string, a ...any) { log.Printf("[sync] "+f, a...) }); err != nil {
		log.Printf("[sync] skills sync failed (continuing): %v", err)
	}
	ssh.Close()
	cancel()

	if err := EnsureProxy(cfg, log); err != nil {
		return err
	}
	if opts.NoTUI {
		log.Printf("stack ready (no TUI requested)")
		return nil
	}
	return runTUI(cfg, log, opts.Args)
}

// EnsureProxy is kept for `setup`/`test`, which must not own a TUI.
func EnsureProxy(cfg *Config, log *Logger) error {
	if PortOpen(cfg.Ports.Proxy) {
		if isOurProxy(cfg.Ports.Proxy) {
			return nil
		}
		// A Python-era proxy on the same port does not speak the cr1 token or
		// the Go control API; replace it rather than fail mysteriously.
		log.Printf("replacing incompatible service on %d", cfg.Ports.Proxy)
		_ = StopPort(cfg.Ports.Proxy, log)
		time.Sleep(500 * time.Millisecond)
	}
	if _, err := LoadOrCreateControlKey(RunDir()); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	runDir := filepath.Join(RunDir(), cfg.Name)
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		return err
	}
	logPath := filepath.Join(runDir, "proxy.log")
	env := EnvironMap()
	env["CODEX_REMOTE_RUN"] = RunDir()
	if _, err := StartDetached([]string{exe, "proxy", "--config", cfg.Path}, env, logPath); err != nil {
		return err
	}
	if !WaitPort(context.Background(), cfg.Ports.Proxy, 30*time.Second) {
		return fmt.Errorf("proxy did not listen on %d; see %s", cfg.Ports.Proxy, logPath)
	}
	log.Printf("proxy started on %d", cfg.Ports.Proxy)
	return nil
}

func isOurProxy(port int) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var body struct {
		Impl string `json:"impl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return false
	}
	return body.Impl == "codex-remote-go"
}

func runTUI(cfg *Config, log *Logger, extra []string) error {
	exe, err := ResolveCodexExe(cfg)
	if err != nil {
		return err
	}
	pane := paneBase()
	// Reuse the pane's env id when it is free, so a TUI that exits and is
	// re-launched in the same shell replaces the old environment instead of
	// accumulating one per launch. If the old TUI is still alive, take a
	// distinct id so the two cannot cross-talk.
	candidate := MakeEnvID(cfg, pane)
	if e := NewLegacyRegistry(RunDir()).ByEnvID(candidate); e != nil && PIDAlive(e.TuiPID) {
		pane = MakePaneID(pane)
	}
	token, claims, err := IssueToken(cfg, pane)
	if err != nil {
		return err
	}

	entry := &LegacyEntry{
		Token:          token,
		EnvID:          claims.EnvID,
		Pane:           pane,
		ConfigName:     cfg.Name,
		ConfigPath:     cfg.Path,
		RemoteCWD:      claims.RemoteCWD,
		RemoteHome:     claims.RemoteHome,
		LocalHome:      claims.LocalHome,
		WinCWD:         claims.WinCWD,
		WinPath:        claims.WinPath,
		BashExe:        claims.BashExe,
		Env:            claims.Env,
		LocalMatch:     claims.LocalMatch,
		LocalWhitelist: claims.LocalWhitelist,
		RemoteOverride: claims.RemoteOverride,
		Yolo:           cfg.Yolo,
		// Reserve the pane before starting codex. A concurrent launch in the
		// same shell sees a live launcher pid and picks a different env id;
		// this closes the race between registry Write and UpdateTuiPID.
		TuiPID: os.Getpid(),
	}
	reg := NewLegacyRegistry(RunDir())
	if err := reg.Write(entry); err != nil {
		log.Printf("registry write failed (continuing): %v", err)
	}

	env := EnvironMap()
	env["CODEX_REMOTE_TOKEN"] = token
	argv := append([]string{exe, "--remote",
		fmt.Sprintf("ws://127.0.0.1:%d", cfg.Ports.Proxy),
		"--remote-auth-token-env", "CODEX_REMOTE_TOKEN"}, extra...)
	log.Printf("launching TUI pane=%s env=%s", pane, claims.EnvID)

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = envSlice(env)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = tuiSysProc()
	if err := cmd.Start(); err != nil {
		return err
	}
	if err := reg.UpdateTuiPID(token, cmd.Process.Pid); err != nil {
		log.Printf("registry update failed: %v", err)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				return fmt.Errorf("codex exited with code %d", ee.ExitCode())
			}
			return err
		}
		return nil
	case <-sig:
		_ = cmd.Process.Kill()
		return nil
	}
}

func IssueToken(cfg *Config, pane string) (string, *Claims, error) {
	key, err := LoadOrCreateTokenKey(RunDir())
	if err != nil {
		return "", nil, err
	}
	return IssueTokenWithKey(cfg, pane, key)
}

func IssueTokenWithKey(cfg *Config, pane string, key *TokenKey) (string, *Claims, error) {
	yolo := cfg.Yolo
	claims := &Claims{
		ConfigPath:     cfg.Path,
		ConfigName:     cfg.Name,
		Pane:           pane,
		RemoteCWD:      cfg.RemoteCWD(),
		RemoteHome:     cfg.RemoteHome(),
		LocalHome:      cfg.LocalHome(),
		WinCWD:         cfg.LocalHome(),
		WinPath:        cfg.WinPath(),
		BashExe:        resolveBash(cfg),
		Env:            CaptureEnvSnapshot(cfg),
		LocalMatch:     cfg.Exec.LocalMatch,
		LocalWhitelist: cfg.Exec.LocalWhitelist,
		RemoteOverride: cfg.Exec.RemoteOverride,
		Yolo:           &yolo,
		IssuedAt:       time.Now().Unix(),
		LauncherPID:    os.Getpid(),
	}
	claims.EnvID = MakeEnvID(cfg, pane)
	tok, err := key.Encode(claims)
	if err != nil {
		return "", nil, err
	}
	return tok, claims, nil
}

// StopConfig asks a running proxy to drop a config's SSH tunnel.
func StopConfig(cfg *Config, log *Logger) error {
	if !PortOpen(cfg.Ports.Proxy) {
		log.Printf("proxy is not running on %d; nothing to stop", cfg.Ports.Proxy)
		return nil
	}
	body, _ := json.Marshal(map[string]string{"config": cfg.Name})
	if err := postControl(cfg, "/control/stop", body); err != nil {
		return err
	}
	// "--stop closes itself": when no TUI is left, take the proxy down too.
	if live, ok := proxyLive(cfg.Ports.Proxy); ok && live == 0 {
		log.Printf("no live TUI left; stopping proxy on %d", cfg.Ports.Proxy)
		return StopPort(cfg.Ports.Proxy, log)
	}
	return nil
}

func proxyLive(port int) (int, bool) {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", port))
	if err != nil {
		return 0, false
	}
	defer resp.Body.Close()
	var body struct {
		Live int `json:"live"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0, false
	}
	return body.Live, true
}

func StopAll(cfg *Config, log *Logger) error {
	if PortOpen(cfg.Ports.Proxy) {
		body, _ := json.Marshal(map[string]any{"all": true})
		if err := postControl(cfg, "/control/stop", body); err != nil {
			log.Printf("control stop failed: %v", err)
		}
	}
	_ = StopPort(cfg.Ports.Proxy, log)
	_ = StopPort(cfg.Ports.WinExecServer, log)
	stopManagedAppServer(log)
	return nil
}

func postControl(cfg *Config, path string, body []byte) error {
	key, err := LoadOrCreateControlKey(RunDir())
	if err != nil {
		return err
	}
	url := fmt.Sprintf("http://127.0.0.1:%d%s", cfg.Ports.Proxy, path)
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("X-Control-Key", key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("control %s: HTTP %d", path, resp.StatusCode)
	}
	return nil
}

func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

// paneBase is stable for the lifetime of the launching shell/pane: a herdr pane
// id when present, otherwise the parent shell's pid.
func paneBase() string {
	if v := envOr("HERDR_PANE_ID", ""); v != "" {
		return v
	}
	return fmt.Sprintf("win-%d", os.Getppid())
}
