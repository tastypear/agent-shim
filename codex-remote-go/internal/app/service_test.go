package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOwnProcessNamesAreExact(t *testing.T) {
	for _, name := range []string{"codex.exe", "CODEX.EXE", "codex-remote.exe", "codex-remote-linux-amd64"} {
		if !isOwnProcess(name) {
			t.Fatalf("expected %q to be ours", name)
		}
	}
	for _, name := range []string{
		"codex-windows-sandbox-service.exe",
		"not-codex.exe",
		"python.exe",
	} {
		if isOwnProcess(name) {
			t.Fatalf("did not expect %q to be ours", name)
		}
	}
}

func TestAppServerSocketIsPerRunDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_REMOTE_RUN", dir)
	got := AppServerSocketPath()
	if !strings.HasPrefix(got, dir) || !strings.HasSuffix(got, "app.sock") {
		t.Fatalf("socket path = %q", got)
	}
	if !strings.HasPrefix(AppServerListenURL(), "unix://") {
		t.Fatalf("listen URL = %q", AppServerListenURL())
	}
}

func TestLocalExecServerPortAlias(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cfg.json")
	if err := os.WriteFile(path, []byte(`{"ports":{"localExecServer":19999}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Ports.LocalExecServer != 19999 || cfg.Ports.WinExecServer != 19999 {
		t.Fatalf("localExecServer alias not normalized: local=%d win=%d",
			cfg.Ports.LocalExecServer, cfg.Ports.WinExecServer)
	}
}

func TestGlobalPortsMigrateLegacyWinKey(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "global.json"),
		[]byte(`{"appServer":19100,"proxy":19311,"winExecServer":19888}`), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := defaultConfig()
	if err := ApplyGlobalPorts(&cfg, dir); err != nil {
		t.Fatal(err)
	}
	if cfg.Ports.LocalExecServer != 19888 || cfg.Ports.WinExecServer != 19888 {
		t.Fatalf("global port migration failed: local=%d win=%d",
			cfg.Ports.LocalExecServer, cfg.Ports.WinExecServer)
	}
}
