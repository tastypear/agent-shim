package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

func CacheDir() string {
	if v := os.Getenv("CODEX_REMOTE_CACHE"); v != "" {
		return v
	}
	return filepath.Join(baseDir(), ".cache")
}

func RunDir() string {
	if v := os.Getenv("CODEX_REMOTE_RUN"); v != "" {
		return v
	}
	return filepath.Join(baseDir(), ".run")
}

func baseDir() string {
	exe, err := os.Executable()
	if err != nil {
		wd, _ := os.Getwd()
		return wd
	}
	dir := filepath.Dir(exe)
	if st, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil && !st.IsDir() {
		return dir
	}
	return dir
}

func PortOpen(port int) bool {
	if port <= 0 {
		return false
	}
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 400*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func WaitPort(ctx context.Context, port int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return false
		default:
		}
		if PortOpen(port) {
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

// The app-server accepts only ws:// for execServerUrl, but its own listener can
// be a Unix socket. Keeping that socket in a private directory is required by
// codex itself ("socket directory is not private to the current user").
func AppServerSocketDir() string {
	return filepath.Join(RunDir(), "app-server")
}

func AppServerSocketPath() string {
	return filepath.Join(AppServerSocketDir(), "app.sock")
}

func AppServerListenURL() string {
	return "unix://" + filepath.ToSlash(AppServerSocketPath())
}

// PlatformOS returns the value codex uses in environmentInfo.platformOs for
// this host. Only the orphan placeholder needs it; a live exec-server reports
// its own real platform.
func PlatformOS() string {
	switch runtime.GOOS {
	case "darwin":
		return "macos"
	default:
		return runtime.GOOS
	}
}

// LocalShell returns the shell name/path the orphan placeholder advertises.
// macOS defaults to zsh, Linux to bash.
func LocalShell() (string, string) {
	if runtime.GOOS == "darwin" {
		return "zsh", "/bin/zsh"
	}
	return "bash", "/bin/bash"
}

func UnixSocketOpen(path string) bool {
	if path == "" {
		return false
	}
	conn, err := net.DialTimeout("unix", path, 400*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func WaitUnixSocket(ctx context.Context, path string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return false
		default:
		}
		if UnixSocketOpen(path) {
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

func EnsurePrivateDir(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		return os.Chmod(path, 0o700)
	}
	user := os.Getenv("USERNAME")
	if user == "" {
		return errors.New("USERNAME is empty; cannot lock app-server socket directory")
	}
	cmd := exec.Command("icacls", path, "/inheritance:r", "/grant:r", user+":(OI)(CI)F")
	cmd.SysProcAttr = hiddenSysProc()
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("icacls %s: %w: %s", path, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func RandomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

var unsafeID = regexp.MustCompile(`[^A-Za-z0-9]+`)

func MakePaneID(base string) string {
	if strings.TrimSpace(base) == "" {
		base = "local"
	}
	safe := strings.Trim(unsafeID.ReplaceAllString(base, "-"), "-")
	if safe == "" {
		safe = "local"
	}
	return safe + "-" + RandomHex(4)
}

func DownloadFile(rawURL, dest, socks string) error {
	client := &http.Client{Timeout: 10 * time.Minute}
	if socks != "" {
		tr, err := socksTransport(socks)
		if err != nil {
			return err
		}
		client.Transport = tr
	}
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "codex-remote-go")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("download %s: %w", rawURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", rawURL, resp.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		_ = f.Close()
		_ = os.Remove(dest)
		return err
	}
	return f.Close()
}

func LocalCodexVersion(cfg *Config) string {
	exe, err := ResolveCodexExe(cfg)
	if err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, exe, "--version").Output()
	if err != nil {
		return ""
	}
	fields := strings.Fields(strings.TrimSpace(string(out)))
	if len(fields) == 0 {
		return ""
	}
	return strings.TrimPrefix(fields[len(fields)-1], "v")
}

func ResolveCodexExe(cfg *Config) (string, error) {
	if p := strings.TrimSpace(cfg.Codex.Exe); p != "" {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
	}
	if runtime.GOOS != "windows" {
		if p, err := exec.LookPath("codex"); err == nil {
			return p, nil
		}
	}
	roots := []string{os.Getenv("APPDATA"), cfg.LocalHome()}
	for _, root := range roots {
		if root == "" {
			continue
		}
		cand := filepath.Join(root, "npm", "node_modules", "@openai", "codex",
			"node_modules", "@openai", "codex-win32-x64", "vendor",
			"x86_64-pc-windows-msvc", "bin", "codex.exe")
		if st, err := os.Stat(cand); err == nil && !st.IsDir() {
			return cand, nil
		}
	}
	return "", errors.New("native codex.exe not found; set codex.exe in the config (do not use the npm shim)")
}

func resolveBash(cfg *Config) string {
	names := []string{"bash"}
	if runtime.GOOS == "windows" {
		names = []string{"bash.exe", "sh.exe"}
	} else if runtime.GOOS == "darwin" {
		names = []string{"zsh", "bash", "sh"}
	}
	for _, d := range filepath.SplitList(cfg.Exec.LocalPath) {
		d = strings.TrimSpace(d)
		if d == "" {
			continue
		}
		for _, name := range names {
			p := filepath.Join(d, name)
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				return p
			}
		}
	}
	if runtime.GOOS != "windows" {
		fallback := []string{"bash", "sh", "zsh"}
		if runtime.GOOS == "darwin" {
			fallback = []string{"zsh", "bash", "sh"}
		}
		for _, name := range fallback {
			if p, err := exec.LookPath(name); err == nil {
				return p
			}
		}
	}
	for _, p := range []string{
		filepath.Join(os.Getenv("ProgramFiles"), "Git", "bin", "bash.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Git", "bin", "bash.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Git", "bin", "bash.exe"),
	} {
		if p == "" {
			continue
		}
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return "bash"
}

func wsURL(port int, path string) string {
	return fmt.Sprintf("ws://127.0.0.1:%d%s", port, path)
}

func splitEnv(kv string) (string, string, bool) {
	i := strings.IndexByte(kv, '=')
	if i <= 0 {
		return "", "", false
	}
	return kv[:i], kv[i+1:], true
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			line := s[start:i]
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			out = append(out, line)
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

func splitFields(s string) []string {
	var out []string
	i := 0
	for i < len(s) {
		for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
			i++
		}
		j := i
		for j < len(s) && s[j] != ' ' && s[j] != '\t' {
			j++
		}
		if j > i {
			out = append(out, s[i:j])
		}
		i = j
	}
	return out
}

func lower(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func hasSuffix(s, suffix string) bool {
	return len(s) >= len(suffix) && s[len(s)-len(suffix):] == suffix
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\r' || s[start] == '\n') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\r' || s[end-1] == '\n') {
		end--
	}
	return s[start:end]
}

func itoa(n int) string {
	return fmt.Sprintf("%d", n)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
