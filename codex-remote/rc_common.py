# Common helpers for the Codex-on-Remote stack (all Python; no Node).
#
# Components share one connection config in the agent-shim style:
#   D:\program\agent-shim\.agent-shim-codex-<name>-ssh.json
#
# This module holds: config loading, SSH (paramiko, optional SOCKS5), the
# remote exec-server install/start lifecycle, port helpers, detached Windows
# process launching, and the per-pane registry.

import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time

import paramiko

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)          # D:\program\agent-shim
CACHE = os.path.join(HERE, ".cache")
RUN = os.path.join(HERE, ".run")
REGISTRY = os.path.join(RUN, "registry")

DEFAULTS = {
    "name": "wsl",
    "ssh": {"host": "127.0.0.1", "user": "root", "port": 22},
    "paths": {"vcwd": "/root", "remoteHome": "", "socksProxy": ""},
    "codex": {"exe": "", "execServerVersion": "0.171.0", "localHome": ""},
    "ports": {
        "appServer": 19100,
        "proxyCwd": 19101,
        "proxyRoute": 19102,
        "tunnel": 19103,
        "winExecServer": 19200,
        "remoteExecServer": 19104,
    },
    "exec": {"localMatch": ["herdr "], "localWhitelist": [], "remoteOverride": []},
    "sync": {"enabled": True, "whitelist": ["skills"]},
    "yolo": True,
    "keepalive": 5000,
    "readyTimeout": 15000,
}


def log(msg):
    stamp = time.strftime("%H:%M:%S")
    print("[%s] %s" % (stamp, msg), flush=True)


def load_config(path):
    if not os.path.isfile(path):
        raise SystemExit("config not found: %s" % path)
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if "ports" not in cfg or "codex" not in cfg:
        raise SystemExit(
            "config %s is missing the 'ports'/'codex' sections; this looks like an "
            "agent-shim (qoder) config, not a codex-remote config. Use "
            ".agent-shim-codex-<name>-ssh.json instead." % path
        )
    merged = json.loads(json.dumps(DEFAULTS))
    for k, v in cfg.items():
        if isinstance(v, dict) and isinstance(merged.get(k), dict):
            merged[k].update(v)
        else:
            merged[k] = v
    merged["_path"] = path
    base = os.path.splitext(os.path.basename(path))[0]
    merged["_name"] = merged.get("name") or base.lstrip(".").replace(".agent-shim-codex-", "").replace("-ssh", "")
    return merged


def resolve_codex_exe(cfg):
    exe = cfg.get("codex", {}).get("exe")
    if exe and os.path.isfile(exe):
        return exe
    for root in (
        os.environ.get("APPDATA", ""),
        os.path.expanduser("~"),
    ):
        if not root:
            continue
        cand = os.path.join(
            root,
            "npm", "node_modules", "@openai", "codex", "node_modules",
            "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc",
            "bin", "codex.exe",
        )
        if os.path.isfile(cand):
            return cand
    raise SystemExit(
        "native codex.exe not found; set codex.exe in the config (the npm shim "
        "launches node.exe and must not be used)"
    )


# ---------------------------------------------------------------------------
# SSH
# ---------------------------------------------------------------------------

def _socks5_connect(proxy_host, proxy_port, dest_host, dest_port, timeout=15):
    import struct

    sock = socket.create_connection((proxy_host, proxy_port), timeout=timeout)
    sock.sendall(b"\x05\x01\x00")
    if sock.recv(2) != b"\x05\x00":
        sock.close()
        raise RuntimeError("socks5 handshake rejected")
    try:
        infos = socket.getaddrinfo(dest_host, dest_port, proto=socket.IPPROTO_TCP)
        af = infos[0][0]
    except OSError:
        af = socket.AF_INET
    if af == socket.AF_INET:
        req = b"\x05\x01\x00\x01" + socket.inet_aton(dest_host) + struct.pack("!H", dest_port)
    elif af == socket.AF_INET6:
        req = b"\x05\x01\x00\x04" + socket.inet_pton(socket.AF_INET6, dest_host) + struct.pack("!H", dest_port)
    else:
        req = b"\x05\x01\x00\x03" + bytes([len(dest_host)]) + dest_host.encode() + struct.pack("!H", dest_port)
    sock.sendall(req)
    head = _recv_exact(sock, 4)
    if head[0] != 0x05:
        sock.close()
        raise RuntimeError("socks5 bad reply")
    atyp = head[3]
    if atyp == 0x01:
        rest = _recv_exact(sock, 4 + 2)
    elif atyp == 0x03:
        ln = _recv_exact(sock, 1)[0]
        rest = _recv_exact(sock, ln + 2)
    elif atyp == 0x04:
        rest = _recv_exact(sock, 16 + 2)
    else:
        sock.close()
        raise RuntimeError("socks5 bad atyp")
    rep = rest[0]
    if rep != 0x00:
        sock.close()
        raise RuntimeError("socks5 connect refused: 0x%02x" % rep)
    return sock


def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise RuntimeError("socks5 closed during handshake")
        buf += chunk
    return buf


def connect_ssh(cfg):
    ssh = cfg.get("ssh", {})
    host = ssh["host"]
    port = int(ssh.get("port", 22))
    user = ssh.get("user", "root")
    sock = None
    prox = cfg.get("paths", {}).get("socksProxy") or ""
    if prox:
        phost, _, pport = prox.partition(":")
        sock = _socks5_connect(phost, int(pport), host, port)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    key_path = ssh.get("keyPath")
    if key_path:
        key_path = os.path.expanduser(key_path)
    client.connect(
        host,
        port=port,
        username=user,
        password=ssh.get("password"),
        key_filename=key_path,
        sock=sock,
        timeout=15,
        banner_timeout=20,
        auth_timeout=20,
        allow_agent=False,
        look_for_keys=False,
    )
    return client


def run_ssh(client, cmd, timeout=60):
    _in, out, err = client.exec_command(cmd, timeout=timeout)
    rc = out.channel.recv_exit_status()
    text = out.read().decode("utf-8", "replace")
    etext = err.read().decode("utf-8", "replace")
    return rc, text, etext


def run_ssh_bg(client, cmd, wait=10):
    """Run a command that leaves a detached daemon behind; never block on EOF."""
    _in, out, _err = client.exec_command(cmd, timeout=wait)
    try:
        out.channel.settimeout(wait)
        out.read()
    except Exception:
        pass
    finally:
        try:
            out.channel.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Ports / processes
# ---------------------------------------------------------------------------

def port_open(port, host="127.0.0.1"):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex((host, int(port))) == 0


def wait_port(port, timeout=20, host="127.0.0.1"):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_open(port, host):
            return True
        time.sleep(0.25)
    return False


def start_detached(argv, env=None, logfile=None):
    """Start a process detached so it survives the launcher exiting."""
    env = dict(os.environ if env is None else env)
    env["NODE_OPTIONS"] = ""
    logf = open(logfile, "ab") if logfile else subprocess.DEVNULL
    flags = 0x00000008  # DETACHED_PROCESS
    flags |= 0x00000200  # CREATE_NEW_PROCESS_GROUP
    flags |= 0x08000000  # CREATE_NO_WINDOW
    proc = subprocess.Popen(
        argv,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=logf,
        stderr=subprocess.STDOUT,
        close_fds=True,
        creationflags=flags,
    )
    return proc.pid


def resolve_bash(cfg):
    lp = cfg.get("exec", {}).get("localPath", "")
    for d in lp.split(";"):
        if not d:
            continue
        p = os.path.join(d, "bash.exe")
        if os.path.isfile(p):
            return p
    candidates = [
        os.path.join(os.environ.get("ProgramFiles", "C:\\Program Files"), "Git", "bin", "bash.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)"), "Git", "bin", "bash.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Git", "bin", "bash.exe"),
    ]
    for p in candidates:
        if p and os.path.isfile(p):
            return p
    return "bash"


def ensure_local_services(cfg):
    """Start the shared local app-server + Windows exec-server if absent."""
    exe = resolve_codex_exe(cfg)
    ports = cfg["ports"]
    run_dir = os.path.join(RUN, cfg["_name"])
    os.makedirs(run_dir, exist_ok=True)

    if not port_open(ports["appServer"]):
        log("starting shared app-server on %d" % ports["appServer"])
        app_env = dict(os.environ)
        app_env["CODEX_HOME"] = os.path.expanduser("~/.codex")
        prox = cfg.get("paths", {}).get("socksProxy") or ""
        if prox:
            app_env.setdefault("HTTPS_PROXY", "socks5://" + prox)
            app_env.setdefault("HTTP_PROXY", "socks5://" + prox)
            app_env.setdefault("ALL_PROXY", "socks5://" + prox)
        start_detached(
            [exe, "app-server", "--listen", "ws://127.0.0.1:%d" % ports["appServer"]],
            env=app_env,
            logfile=os.path.join(run_dir, "app-server.log"),
        )
        if not wait_port(ports["appServer"]):
            raise SystemExit("app-server did not start; see %s" % run_dir)

    if not port_open(ports["winExecServer"]):
        log("starting Windows exec-server on %d" % ports["winExecServer"])
        start_detached(
            [exe, "exec-server", "--listen", "ws://127.0.0.1:%d" % ports["winExecServer"]],
            logfile=os.path.join(run_dir, "win-exec-server.log"),
        )
        if not wait_port(ports["winExecServer"]):
            raise SystemExit("Windows exec-server did not start; see %s" % run_dir)

    return exe


# ---------------------------------------------------------------------------
# Remote exec-server install / start (like remote-codex: versioned, sha256)
# ---------------------------------------------------------------------------

_ARCH_TOKENS = {
    "x86_64": "x86_64",
    "amd64": "x86_64",
    "aarch64": "aarch64",
    "arm64": "aarch64",
}


def remote_arch(client):
    rc, out, _ = run_ssh(client, "uname -m")
    machine = out.strip().lower()
    token = _ARCH_TOKENS.get(machine)
    if not token:
        raise SystemExit("unsupported remote architecture: %r" % machine)
    return token


def _remote_dir(cfg, arch):
    return "/opt/codex-remote/runtimes/codex/%s-linux-%s" % (
        cfg["codex"]["execServerVersion"],
        arch,
    )


def _bin_name(arch):
    return "codex-exec-server-%s-unknown-linux-musl" % arch


def _exec_server_tarball(cfg, arch):
    ver = cfg["codex"]["execServerVersion"]
    name = _bin_name(arch) + ".tar.gz"
    d = os.path.join(CACHE, "exec-server", ver, arch)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, name)
    if not os.path.isfile(path):
        url = (
            "https://github.com/openai/codex/releases/download/"
            "rust-v%s/%s" % (ver, name)
        )
        log("downloading %s" % name)
        cmd = ["curl", "-fsSL", "--retry", "3", "-o", path, url]
        prox = cfg.get("paths", {}).get("socksProxy") or ""
        if prox:
            phost, _, pport = prox.partition(":")
            cmd[2:2] = ["--proxy", "socks5://%s:%s" % (phost, pport)]
        subprocess.run(cmd, check=True)
    return path


def install_remote_exec_server(cfg, client):
    """Ensure the Linux exec-server binary for the remote arch is installed."""
    ver = cfg["codex"]["execServerVersion"]
    arch = remote_arch(client)
    cfg["_remoteArch"] = arch
    rdir = _remote_dir(cfg, arch)
    bin_name = _bin_name(arch)
    tarball = _exec_server_tarball(cfg, arch)
    pkg_sha = hashlib.sha256(open(tarball, "rb").read()).hexdigest()
    rc, out, _ = run_ssh(
        client,
        "test -x %s/%s && test -f %s/.pkgsha && cat %s/.pkgsha || echo missing"
        % (rdir, bin_name, rdir, rdir),
    )
    if out.strip() == pkg_sha:
        log("remote exec-server (%s) already installed: %s" % (arch, rdir))
        return rdir
    log("installing remote exec-server %s (%s) to %s" % (ver, arch, rdir))
    run_ssh(client, "mkdir -p %s" % rdir)
    sftp = client.open_sftp()
    pkg = rdir + "/pkg.tar.gz"
    sftp.put(tarball, pkg)
    sftp.close()
    rc, out, _ = run_ssh(client, "cd %s && sha256sum pkg.tar.gz" % rdir)
    if out.split()[0] != pkg_sha:
        raise SystemExit("remote tarball sha256 mismatch")
    run_ssh(
        client,
        "cd %s && tar -xzf pkg.tar.gz && rm -f pkg.tar.gz && chmod 755 %s && echo %s > .pkgsha"
        % (rdir, bin_name, pkg_sha),
    )
    log("remote exec-server (%s) installed" % arch)
    return rdir


def start_remote_exec_server(cfg, client, rdir):
    """Start the remote exec-server with a private CODEX_HOME; idempotent."""
    port = cfg["ports"]["remoteExecServer"]
    home = "/opt/codex-remote/home"
    pidfile = "/opt/codex-remote/exec-server.pid"
    arch = cfg.get("_remoteArch", "x86_64")
    rc, out, _ = run_ssh(client, "ss -ltn 2>/dev/null | grep -q ':%d ' && echo up || echo down" % port)
    if out.strip() == "up":
        log("remote exec-server already up on %d" % port)
        return
    bin = "%s/%s" % (rdir, _bin_name(arch))
    log("starting remote exec-server on %d" % port)
    cmd = (
        "mkdir -p %s && chmod 700 %s && "
        "setsid bash -c 'exec env CODEX_HOME=%s %s --listen ws://127.0.0.1:%d' "
        "</dev/null >/opt/codex-remote/exec-server.log 2>&1 & echo $! > %s"
        % (home, home, home, bin, port, pidfile)
    )
    run_ssh_bg(client, cmd)
    if not wait_remote_port(cfg, client, port):
        rc, out, _ = run_ssh(client, "cat /opt/codex-remote/exec-server.log | tail -30")
        raise SystemExit(
            "remote exec-server (%s) did not come up on %d; log:\n%s" % (arch, port, out)
        )
    log("remote exec-server up on %d" % port)


def wait_remote_port(cfg, client, port, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        rc, out, _ = run_ssh(client, "ss -ltn 2>/dev/null | grep -q ':%d ' && echo up || echo down" % port)
        if out.strip() == "up":
            return True
        time.sleep(0.5)
    return False


# ---------------------------------------------------------------------------
# SSH tunnel (local TCP listener -> remote exec-server through SSH)
# ---------------------------------------------------------------------------

def open_tunnel(cfg, client, local_port):
    """Bind local_port and forward every accepted connection to the remote
    exec-server port through the SSH transport. Returns the listener."""
    import threading

    transport = client.get_transport()
    remote_host = "127.0.0.1"
    remote_port = cfg["ports"]["remoteExecServer"]
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", local_port))
    listener.listen(16)
    stop = threading.Event()

    def pump(src, dst):
        # Full-duplex: each direction runs in its own thread so an idle side
        # never blocks the other (the old single-thread loop stalled server
        # output until the next client byte, e.g. a 20s websockets ping).
        try:
            while not stop.is_set():
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except Exception:
            pass
        finally:
            try:
                dst.shutdown(socket.SHUT_WR)
            except Exception:
                pass

    def handle(client_sock):
        try:
            chan = transport.open_channel(
                "direct-tcpip", (remote_host, remote_port), client_sock.getpeername()
            )
        except Exception as e:
            log("tunnel open_channel failed: %s" % e)
            client_sock.close()
            return
        client_sock.settimeout(None)
        up = threading.Thread(target=pump, args=(chan, client_sock), daemon=True)
        up.start()
        pump(client_sock, chan)
        up.join(timeout=1.0)
        try:
            chan.close()
        except Exception:
            pass
        try:
            client_sock.close()
        except Exception:
            pass

    def accept_loop():
        listener.settimeout(0.5)
        while not stop.is_set():
            try:
                conn, _ = listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=handle, args=(conn,), daemon=True).start()

    threading.Thread(target=accept_loop, daemon=True).start()
    log("tunnel open: 127.0.0.1:%d -> %s:%d" % (local_port, remote_host, remote_port))
    return listener, stop


# ---------------------------------------------------------------------------
# Registry (per-pane identity)
# ---------------------------------------------------------------------------

def ensure_registry_dir():
    os.makedirs(REGISTRY, exist_ok=True)


def load_registry():
    ensure_registry_dir()
    out = {}
    for fn in os.listdir(REGISTRY):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(REGISTRY, fn), "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            continue
        out[cfg.get("token")] = cfg
    return out


def write_registry(entry):
    ensure_registry_dir()
    path = os.path.join(REGISTRY, entry["token"] + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(entry, f, ensure_ascii=False)
    return path


def make_env_id(cfg, pane_id):
    safe = re.sub(r"[^A-Za-z0-9]+", "-", pane_id or "nopane").strip("-").lower()
    return "%s-%s" % (cfg["_name"], safe)


def make_token(cfg, pane_id):
    seed = "|".join([cfg["_name"], cfg.get("_path", ""), pane_id or "nopane"])
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:32]


# ---------------------------------------------------------------------------
# skills sync
# ---------------------------------------------------------------------------

SKILLS_EXCLUDE = (
    ".git", "node_modules", "target", "__pycache__", ".env", ".env.",
    "auth.json", "credentials.json", ".DS_Store",
)


def sync_skills(cfg, client, logfn=log):
    """Mirror ~/.codex/skills to <remoteHome>/.codex/skills, idempotent."""
    sync = cfg.get("sync", {})
    if not sync.get("enabled") or "skills" not in (sync.get("whitelist") or []):
        return
    local = os.path.expanduser("~/.codex/skills")
    if not os.path.isdir(local):
        logfn("no local ~/.codex/skills to sync")
        return
    remote_home = cfg["paths"]["remoteHome"] or _detect_remote_home(cfg, client)
    remote_dir = remote_home.rstrip("/") + "/.codex/skills"

    manifest = {}
    total = 0
    for root, dirs, files in os.walk(local):
        dirs[:] = [d for d in dirs if d not in SKILLS_EXCLUDE]
        for fn in files:
            if fn in SKILLS_EXCLUDE or fn.endswith((".pem", ".key")) or fn.startswith("id_"):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, local).replace("\\", "/")
            with open(full, "rb") as f:
                data = f.read()
            manifest[rel] = (len(data), hashlib.sha256(data).hexdigest())
            total += len(data)
    digest = hashlib.sha256(
        json.dumps(manifest, sort_keys=True).encode("utf-8")
    ).hexdigest()

    rc, out, _ = run_ssh(
        client,
        "test -f %s/.digest && cat %s/.digest || echo none" % (remote_dir, remote_dir),
    )
    if out.strip() == digest:
        logfn("skills already in sync (%d files)" % len(manifest))
        return

    logfn("syncing %d skills files (%d bytes) to %s" % (len(manifest), total, remote_dir))
    sftp = client.open_sftp()
    _sftp_mkdirs(sftp, remote_dir)
    for rel, (size, sha) in manifest.items():
        remote_path = remote_dir + "/" + rel
        _sftp_mkdirs(sftp, os.path.dirname(remote_path))
        sftp.put(os.path.join(local, *rel.split("/")), remote_path)
    sftp.close()
    run_ssh(client, "echo %s > %s/.digest" % (digest, remote_dir))
    logfn("skills synced (%s)" % digest[:12])


def _sftp_mkdirs(sftp, path):
    if not path or path == "/":
        return
    parts = [p for p in path.split("/") if p]
    cur = ""
    for p in parts:
        cur = cur + "/" + p
        try:
            sftp.stat(cur)
        except IOError:
            try:
                sftp.mkdir(cur)
            except IOError:
                pass


def _detect_remote_home(cfg, client):
    rc, out, _ = run_ssh(client, "echo $HOME")
    home = out.strip()
    if home:
        cfg["paths"]["remoteHome"] = home
        return home
    return "/root"
