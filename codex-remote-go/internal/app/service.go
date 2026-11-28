package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const appServerPIDName = "app-server.pid"

func appServerPIDPath() string {
	return filepath.Join(RunDir(), appServerPIDName)
}

func readPID(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
	return pid
}

func writePID(path string, pid int) {
	if pid > 0 {
		_ = os.WriteFile(path, []byte(strconv.Itoa(pid)), 0o600)
	}
}

// EnsureLocalServices starts the shared app-server and local exec-server if
// they are not already listening. The app-server listens on a private Unix
// socket: its execServerUrl still has to be ws://, but its own listener does
// not, so this removes one TCP port without changing the protocol.
func EnsureLocalServices(cfg *Config, log *Logger) (string, error) {
	exe, err := ResolveCodexExe(cfg)
	if err != nil {
		return "", err
	}
	runDir := filepath.Join(RunDir(), cfg.Name)
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		return "", err
	}
	// Remember the shell environment the shared services inherit. Later panes
	// diff against it to send only their own variables.
	_ = WriteBaseEnv(EnvironMap())

	sock := AppServerSocketPath()
	if !UnixSocketOpen(sock) {
		if err := EnsurePrivateDir(AppServerSocketDir()); err != nil {
			return "", err
		}
		// Only remove the path after confirming nobody is listening on it.
		_ = os.Remove(sock)
		log.Printf("starting shared app-server on unix:%s", sock)
		env := EnvironMap()
		env["CODEX_HOME"] = expandHome("~/.codex")
		if p := cfg.SocksProxy(); p != "" {
			if env["HTTPS_PROXY"] == "" {
				env["HTTPS_PROXY"] = "socks5://" + p
			}
			if env["HTTP_PROXY"] == "" {
				env["HTTP_PROXY"] = "socks5://" + p
			}
			if env["ALL_PROXY"] == "" {
				env["ALL_PROXY"] = "socks5://" + p
			}
		}
		argv := []string{exe, "app-server", "--listen", AppServerListenURL()}
		pid, err := StartDetached(argv, env, filepath.Join(runDir, "app-server.log"))
		if err != nil {
			return "", fmt.Errorf("start app-server: %w", err)
		}
		writePID(appServerPIDPath(), pid)
		if !WaitUnixSocket(context.Background(), sock, 30*time.Second) {
			return "", fmt.Errorf("app-server did not listen on unix:%s; see %s",
				sock, filepath.Join(runDir, "app-server.log"))
		}
	}

	if !PortOpen(cfg.Ports.WinExecServer) {
		log.Printf("starting local exec-server on %d", cfg.Ports.WinExecServer)
		argv := []string{exe, "exec-server", "--listen",
			fmt.Sprintf("ws://127.0.0.1:%d", cfg.Ports.WinExecServer)}
		if _, err := StartDetached(argv, EnvironMap(), filepath.Join(runDir, "local-exec-server.log")); err != nil {
			return "", fmt.Errorf("start local exec-server: %w", err)
		}
		if !WaitPort(context.Background(), cfg.Ports.WinExecServer, 30*time.Second) {
			return "", fmt.Errorf("local exec-server did not listen on %d; see %s",
				cfg.Ports.WinExecServer, filepath.Join(runDir, "local-exec-server.log"))
		}
	}
	return exe, nil
}

// stopManagedAppServer only kills the pid we recorded, and only after checking
// the image name. This is the same by-PID rule used for ports; no name-wide
// process sweeps.
func stopManagedAppServer(log *Logger) {
	path := appServerPIDPath()
	pid := readPID(path)
	if pid <= 0 {
		_ = os.Remove(AppServerSocketPath())
		return
	}
	name := ProcessImageName(pid)
	if name == "" {
		_ = os.Remove(path)
		_ = os.Remove(AppServerSocketPath())
		return
	}
	if !isOwnProcess(name) && !isManagedAppServer(pid) {
		log.Printf("skip app-server pid=%d name=%s (not ours)", pid, name)
		return
	}
	if err := KillPID(pid); err != nil {
		log.Printf("stop app-server pid=%d failed: %v", pid, err)
		return
	}
	log.Printf("stopped app-server pid=%d (%s)", pid, name)
	_ = os.Remove(path)
	_ = os.Remove(AppServerSocketPath())
}

// ServeProxy runs the single-port proxy in the foreground.
func ServeProxy(cfg *Config, log *Logger) error {
	p, err := NewProxy(cfg, RunDir(), log)
	if err != nil {
		return err
	}
	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Ports.Proxy)
	srv := &http.Server{
		Addr:              addr,
		Handler:           p.Handler(),
		ReadHeaderTimeout: 20 * time.Second,
	}
	log.Printf("proxy listening on %s (cwd+route demuxed by path)", addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func StopPort(port int, log *Logger) error {
	pids := PortPIDs(port)
	if len(pids) == 0 {
		return nil
	}
	var lastErr error
	for _, pid := range pids {
		name := ProcessImageName(pid)
		if name == "" {
			continue
		}
		if !isOwnProcess(name) {
			log.Printf("skip port %d pid=%d name=%s (not ours)", port, pid, name)
			continue
		}
		if err := KillPID(pid); err != nil {
			lastErr = err
			log.Printf("kill pid %d failed: %v", pid, err)
			continue
		}
		log.Printf("stopped port %d pid=%d (%s)", port, pid, name)
	}
	return lastErr
}

func isOwnProcess(name string) bool {
	name = lower(name)
	switch {
	case name == "codex", name == "codex.exe":
		return true
	case strings.HasPrefix(name, "codex-remote"):
		return true
	default:
		return false
	}
}

func isManagedAppServer(pid int) bool {
	cmd := ProcessCommandLine(pid)
	return strings.Contains(cmd, "app-server") && strings.Contains(cmd, AppServerSocketPath())
}
