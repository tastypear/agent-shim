package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	defaultRemoteHome = "/opt/codex-remote/home"
	execServerLog     = "/opt/codex-remote/exec-server.log"
	execServerPID     = "/opt/codex-remote/exec-server.pid"
)

type Remote struct {
	cfg  *Config
	ssh  *RemoteSSH
	arch string
	dir  string
}

func NewRemote(cfg *Config, sshc *RemoteSSH) *Remote {
	return &Remote{cfg: cfg, ssh: sshc}
}

func (r *Remote) ExecAddr() string {
	return fmt.Sprintf("127.0.0.1:%d", r.cfg.Ports.RemoteExecServer)
}

func (r *Remote) archToken(machine string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(machine)) {
	case "x86_64", "amd64":
		return "x86_64", nil
	case "aarch64", "arm64":
		return "aarch64", nil
	default:
		return "", fmt.Errorf("unsupported remote architecture %q", machine)
	}
}

func (r *Remote) Ensure(ctx context.Context, logf func(string, ...any)) error {
	out, errs, code, err := r.ssh.Run(ctx, "uname -m", 20*time.Second)
	if err != nil {
		return fmt.Errorf("uname: %w (%s)", err, errs)
	}
	if code != 0 {
		return fmt.Errorf("uname exit %d: %s", code, errs)
	}
	arch, err := r.archToken(out)
	if err != nil {
		return err
	}
	r.arch = arch

	version, err := r.resolveVersion(ctx)
	if err != nil {
		return err
	}
	r.dir = path.Join(r.cfg.Remote.InstallRoot, version+"-linux-"+arch)
	if err := r.install(ctx, version, logf); err != nil {
		return err
	}
	if err := r.ensureVersion(ctx, version, logf); err != nil {
		return err
	}
	if err := r.start(ctx, logf); err != nil {
		return err
	}
	return nil
}

// ensureVersion reuses an already-running exec-server only when the process
// actually listening on our port is the pinned binary. exec-server reports
// executorVersion "0.0.0" from `initialize`, so the on-disk/on-process path is
// the only reliable signal.
func (r *Remote) ensureVersion(ctx context.Context, want string, logf func(string, ...any)) error {
	if !r.portListening(ctx, r.cfg.Ports.RemoteExecServer) {
		return nil
	}
	got, err := r.runningBinary(ctx)
	if err != nil {
		logf("could not identify running exec-server (%v); restarting it", err)
		got = ""
	}
	wantBin := path.Join(r.dir, binName(r.arch))
	if got == wantBin {
		return nil
	}
	if !r.cfg.Remote.RestartOnVersionMismatch {
		return fmt.Errorf("remote exec-server is %s, want %s (restartOnVersionMismatch=false)", got, wantBin)
	}
	logf("remote exec-server binary %q != %q; restarting", got, wantBin)
	if err := r.stopRunning(ctx); err != nil {
		return err
	}
	return nil
}

func (r *Remote) runningBinary(ctx context.Context) (string, error) {
	port := r.cfg.Ports.RemoteExecServer
	cmd := fmt.Sprintf(`listen="--listen ws://127.0.0.1:%d"
for d in /proc/[0-9]*; do
  pid=${d#/proc/}
  [ "$pid" = "$$" ] && continue
  [ -r "$d/cmdline" ] || continue
  if tr '\0' ' ' < "$d/cmdline" 2>/dev/null | grep -qF -- "$listen"; then
    exe=$(readlink "$d/exe" 2>/dev/null) || continue
    case "$exe" in
      *codex-exec-server*) echo "$exe"; exit 0 ;;
    esac
  fi
done
exit 1`, port)
	out, _, code, err := r.ssh.Run(ctx, cmd, 20*time.Second)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", errors.New("no process found listening for our port")
	}
	// /proc/<pid>/exe may end with " (deleted)" when the file was replaced.
	p := strings.TrimSuffix(strings.TrimSpace(out), " (deleted)")
	if p == "" {
		return "", errors.New("empty /proc/<pid>/exe")
	}
	return p, nil
}

func (r *Remote) stopRunning(ctx context.Context) error {
	port := r.cfg.Ports.RemoteExecServer
	// The pidfile holds the shell that backgrounded the server, not the
	// server itself, so find the real owner by its `--listen` argument.
	cmd := fmt.Sprintf(`set -e
listen='--listen ws://127.0.0.1:%d'
pids=""
for d in /proc/[0-9]*; do
  pid=${d#/proc/}
  [ "$pid" = "$$" ] && continue
  [ -r "$d/cmdline" ] || continue
  if tr '\0' ' ' < "$d/cmdline" 2>/dev/null | grep -qF -- "$listen"; then
    pids="$pids $pid"
  fi
done
if [ -z "$pids" ]; then rm -f %s; exit 0; fi
kill $pids 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do
  alive=""
  for p in $pids; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
  [ -z "$alive" ] && break
  sleep 0.3
done
for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
rm -f %s
`, port, execServerPID, execServerPID)
	_, errs, code, err := r.ssh.Run(ctx, cmd, 30*time.Second)
	if err != nil || code != 0 {
		return fmt.Errorf("stop old exec-server: %v %s", err, errs)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if !r.portListening(ctx, r.cfg.Ports.RemoteExecServer) {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return errors.New("old exec-server still listening after stop")
}

func (r *Remote) resolveVersion(ctx context.Context) (string, error) {
	want := strings.TrimSpace(r.cfg.Codex.ExecServerVersion)
	local := LocalCodexVersion(r.cfg)
	switch {
	case want != "" && local != "" && want != local:
		if r.cfg.Codex.StrictVersion {
			return "", fmt.Errorf("codex.execServerVersion=%s but local codex is %s", want, local)
		}
		return local, nil
	case want != "":
		return want, nil
	case local != "":
		return local, nil
	default:
		return "", errors.New("cannot determine exec-server version: set codex.execServerVersion")
	}
}

func binName(arch string) string {
	return fmt.Sprintf("codex-exec-server-%s-unknown-linux-musl", arch)
}

func (r *Remote) localTarball(version, arch string) (string, error) {
	name := binName(arch) + ".tar.gz"
	dir := filepath.Join(CacheDir(), "exec-server", version, arch)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	p := filepath.Join(dir, name)
	if st, err := os.Stat(p); err == nil && st.Size() > 0 {
		return p, nil
	}
	// Tolerate the older flat cache layout used by the Python implementation.
	legacy := filepath.Join(CacheDir(), "exec-server", version, name)
	if st, err := os.Stat(legacy); err == nil && st.Size() > 0 {
		return legacy, nil
	}
	url := fmt.Sprintf("https://github.com/openai/codex/releases/download/rust-v%s/%s", version, name)
	tmp := p + ".part"
	if err := DownloadFile(url, tmp, r.cfg.SocksProxy()); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, p); err != nil {
		return "", err
	}
	return p, nil
}

func (r *Remote) install(ctx context.Context, version string, logf func(string, ...any)) error {
	tarball, err := r.localTarball(version, r.arch)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(tarball)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	pkgSHA := hex.EncodeToString(sum[:])

	out, _, _, err := r.ssh.Run(ctx,
		fmt.Sprintf("test -x %s/%s && cat %s/.pkgsha 2>/dev/null || echo missing",
			r.dir, binName(r.arch), r.dir), 30*time.Second)
	if err != nil {
		return err
	}
	if strings.TrimSpace(out) == pkgSHA {
		logf("remote exec-server %s already installed (%s)", r.arch, r.dir)
		return nil
	}
	logf("installing remote exec-server %s (%s) -> %s", version, r.arch, r.dir)
	if _, errs, code, err := r.ssh.Run(ctx, "mkdir -p "+r.dir, 20*time.Second); err != nil || code != 0 {
		return fmt.Errorf("mkdir %s: %v %s", r.dir, err, errs)
	}
	remotePkg := r.dir + "/pkg.tar.gz"
	if err := r.upload(ctx, tarball, remotePkg); err != nil {
		return err
	}
	out, errs, code, err := r.ssh.Run(ctx,
		fmt.Sprintf("cd %s && sha256sum pkg.tar.gz", r.dir), 60*time.Second)
	if err != nil || code != 0 {
		return fmt.Errorf("sha256sum remote: %v %s", err, errs)
	}
	if fields := strings.Fields(out); len(fields) == 0 || fields[0] != pkgSHA {
		return errors.New("remote tarball sha256 mismatch")
	}
	cmd := fmt.Sprintf(
		"cd %s && tar -xzf pkg.tar.gz && rm -f pkg.tar.gz && chmod 755 %s && printf %%s %s > .pkgsha",
		r.dir, binName(r.arch), pkgSHA)
	if _, errs, code, err := r.ssh.Run(ctx, cmd, 120*time.Second); err != nil || code != 0 {
		return fmt.Errorf("unpack remote tarball: %v %s", err, errs)
	}
	logf("remote exec-server %s installed", r.arch)
	return nil
}

func (r *Remote) upload(ctx context.Context, local, remote string) error {
	sc, err := r.ssh.Sftp(ctx)
	if err != nil {
		return err
	}
	defer sc.Close()
	src, err := os.Open(local)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := sc.Create(remote)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		_ = dst.Close()
		return err
	}
	return dst.Close()
}

func (r *Remote) portListening(ctx context.Context, port int) bool {
	// Only a LISTEN socket counts. Grepping the whole /proc/net/tcp line also
	// matches the remote peer of a TIME_WAIT entry, which made a stopped
	// exec-server look alive.
	cmd := fmt.Sprintf(`p=%[1]d; h=$(printf '%%04X' $p)
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE ":$p[[:space:]]"; then echo up; exit 0; fi
if [ -r /proc/net/tcp ] && awk -v h=":$h" '$2 ~ h"$" && $4=="0A" {f=1} END{exit !f}' /proc/net/tcp; then echo up; exit 0; fi
if command -v netstat >/dev/null 2>&1 && netstat -ltn 2>/dev/null | grep -qE ":$p[[:space:]]"; then echo up; exit 0; fi
echo down`, port)
	out, _, _, err := r.ssh.Run(ctx, cmd, 20*time.Second)
	return err == nil && strings.TrimSpace(out) == "up"
}

func (r *Remote) start(ctx context.Context, logf func(string, ...any)) error {
	port := r.cfg.Ports.RemoteExecServer
	home := r.cfg.Remote.PrivateHome
	if home == "" {
		home = defaultRemoteHome
	}
	if r.portListening(ctx, port) {
		logf("remote exec-server already listening on %d", port)
		return nil
	}
	bin := path.Join(r.dir, binName(r.arch))
	cmd := fmt.Sprintf(
		"mkdir -p %[1]s && chmod 700 %[1]s && "+
			"setsid bash -c 'exec env CODEX_HOME=%[1]s %[2]s --listen ws://127.0.0.1:%[3]d' "+
			"</dev/null >%[4]s 2>&1 & echo $! > %[5]s",
		home, bin, port, execServerLog, execServerPID)
	if err := r.ssh.RunDetached(ctx, cmd); err != nil {
		return err
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if r.portListening(ctx, port) {
			logf("remote exec-server up on %d", port)
			return nil
		}
		time.Sleep(400 * time.Millisecond)
	}
	out, _, _, _ := r.ssh.Run(ctx, "tail -30 "+execServerLog, 20*time.Second)
	return fmt.Errorf("remote exec-server did not listen on %d; log:\n%s", port, out)
}

// RemoteHome detects $HOME once and caches it on the config.
func (r *Remote) RemoteHome(ctx context.Context) (string, error) {
	if h := strings.TrimSpace(r.cfg.Paths.RemoteHome); h != "" {
		return h, nil
	}
	out, _, code, err := r.ssh.Run(ctx, "printf %s \"$HOME\"", 20*time.Second)
	if err != nil || code != 0 {
		return "", fmt.Errorf("detect remote home: %v", err)
	}
	h := strings.TrimSpace(out)
	if h == "" {
		h = "/root"
	}
	r.cfg.Paths.RemoteHome = h
	return h, nil
}

// ---------------------------------------------------------------------------
// skills sync (content addressed, whitelist only)
// ---------------------------------------------------------------------------

var skillExcludeNames = map[string]bool{
	".git": true, "node_modules": true, "target": true, "__pycache__": true,
	".DS_Store": true, "auth.json": true, "credentials.json": true,
}

type skillFile struct {
	rel  string
	size int64
	sum  string
}

func collectSkills(local string, extraExclude []string) ([]skillFile, string, int64, error) {
	exclude := map[string]bool{}
	for k := range skillExcludeNames {
		exclude[k] = true
	}
	for _, v := range extraExclude {
		exclude[v] = true
	}
	var files []skillFile
	var total int64
	seen := map[string]bool{}
	var walk func(dir string) error
	walk = func(dir string) error {
		// Junctions (e.g. a skill linked from a shared library) report as
		// non-directories under Lstat, so resolve and dedupe by real path.
		if real, err := filepath.EvalSymlinks(dir); err == nil {
			if seen[real] {
				return nil
			}
			seen[real] = true
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, d := range entries {
			name := d.Name()
			if exclude[name] || strings.HasPrefix(name, ".env") {
				continue
			}
			p := filepath.Join(dir, name)
			st, err := os.Stat(p)
			if err != nil {
				continue
			}
			if st.IsDir() {
				if err := walk(p); err != nil {
					return err
				}
				continue
			}
			if !st.Mode().IsRegular() || strings.HasSuffix(name, ".pem") ||
				strings.HasSuffix(name, ".key") || strings.HasPrefix(name, "id_") {
				continue
			}
			rel, err := filepath.Rel(local, p)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			data, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			sum := sha256.Sum256(data)
			files = append(files, skillFile{rel: rel, size: int64(len(data)), sum: hex.EncodeToString(sum[:])})
			total += int64(len(data))
		}
		return nil
	}
	err := walk(local)
	if err != nil {
		return nil, "", 0, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].rel < files[j].rel })
	type entry struct {
		Rel  string `json:"rel"`
		Size int64  `json:"size"`
		Sum  string `json:"sum"`
	}
	manifest := make([]entry, 0, len(files))
	for _, f := range files {
		manifest = append(manifest, entry{f.rel, f.size, f.sum})
	}
	raw, _ := json.Marshal(manifest)
	digest := sha256.Sum256(raw)
	return files, hex.EncodeToString(digest[:]), total, nil
}

func (r *Remote) SyncSkills(ctx context.Context, logf func(string, ...any)) error {
	if !r.cfg.ShouldSync("skills") {
		return nil
	}
	local := filepath.Join(expandHome("~/.codex"), "skills")
	if st, err := os.Stat(local); err != nil || !st.IsDir() {
		logf("no local ~/.codex/skills to sync")
		return nil
	}
	home, err := r.RemoteHome(ctx)
	if err != nil {
		return err
	}
	remoteDir := path.Join(home, ".codex/skills")
	files, digest, total, err := collectSkills(local, r.cfg.Sync.Exclude)
	if err != nil {
		return err
	}
	out, _, _, err := r.ssh.Run(ctx,
		fmt.Sprintf("cat %s/.digest 2>/dev/null || echo none", remoteDir), 20*time.Second)
	if err != nil {
		return err
	}
	if strings.TrimSpace(out) == digest {
		logf("skills already in sync (%d files)", len(files))
		return nil
	}
	logf("syncing %d skills files (%d bytes) to %s", len(files), total, remoteDir)
	sc, err := r.ssh.Sftp(ctx)
	if err != nil {
		return err
	}
	defer sc.Close()
	if err := sftpMkdirAll(sc, remoteDir); err != nil {
		return err
	}
	for _, f := range files {
		src := filepath.Join(local, filepath.FromSlash(f.rel))
		dstPath := path.Join(remoteDir, f.rel)
		if err := sftpMkdirAll(sc, path.Dir(dstPath)); err != nil {
			return err
		}
		srcF, err := os.Open(src)
		if err != nil {
			return err
		}
		dstF, err := sc.Create(dstPath)
		if err != nil {
			_ = srcF.Close()
			return err
		}
		if _, err := io.Copy(dstF, srcF); err != nil {
			_ = srcF.Close()
			_ = dstF.Close()
			return err
		}
		_ = srcF.Close()
		if err := dstF.Close(); err != nil {
			return err
		}
	}
	_, errs, code, err := r.ssh.Run(ctx,
		fmt.Sprintf("printf %%s %s > %s/.digest", digest, remoteDir), 20*time.Second)
	if err != nil || code != 0 {
		return fmt.Errorf("write skills digest: %v %s", err, errs)
	}
	logf("skills synced (%s)", digest[:12])
	return nil
}

type sftpMkdir interface {
	Stat(string) (os.FileInfo, error)
	Mkdir(string) error
}

func sftpMkdirAll(sc sftpMkdir, p string) error {
	p = path.Clean(p)
	if p == "/" || p == "." || p == "" {
		return nil
	}
	var parts []string
	for cur := p; cur != "/" && cur != "."; cur = path.Dir(cur) {
		parts = append(parts, cur)
	}
	for i := len(parts) - 1; i >= 0; i-- {
		cur := parts[i]
		if _, err := sc.Stat(cur); err == nil {
			continue
		}
		if err := sc.Mkdir(cur); err != nil {
			if _, e2 := sc.Stat(cur); e2 == nil {
				continue
			}
			return err
		}
	}
	return nil
}
