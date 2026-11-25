# Shared Codex-on-Remote proxy: TWO websocket servers in one process.
#
#   cwd role  <proxyCwd>   TUI side.
#     Reads `Authorization: Bearer <token>` -> resolves the pane config from
#     the registry. Connects to the single shared app-server. On the TUI's
#     `initialize` it registers this pane's environment (`environment/add`)
#     and injects cwd/environments/runtimeWorkspaceRoots + strong yolo into
#     thread/turn/settings requests.
#
#   route role <proxyRoute>   app-server side.
#     Reads ws.path `/env/<envId>` -> resolves the pane config. Primary
#     outbound = remote exec-server (via the SSH tunnel); secondary = Windows
#     exec-server (its own handshake). Routes process/start by argv
#     (default remote; local whitelist -> Windows), normalizes paths, and
#     injects per-pane HERDR_* for local commands.
#
# The proxy is long-lived and stateless across pane restarts: identity rides
# on every connection (bearer token / path), so it never tracks lifecycle.

import asyncio
import json
import os
import re
import sys
import time
from urllib.parse import urlparse

from websockets import serve, connect

HOST = "127.0.0.1"
# One proxy port serves both roles, demuxed by path: `/env/<id>` -> route role
# (app-server side), everything else (path `/` + bearer token) -> cwd role.
PROXY_PORT = int(os.environ.get("CP_PROXY_PORT") or os.environ.get("CP_CWD_PORT") or "0")
UPSTREAM = os.environ.get("CP_UPSTREAM", "ws://127.0.0.1:19100")
REMOTE = os.environ.get("CP_REMOTE", "ws://127.0.0.1:19103")
WINDOW = os.environ.get("CP_WINDOW", "ws://127.0.0.1:19200")
REGISTRY = os.environ.get("CP_REGISTRY", "")
LOG = os.environ.get("CP_LOG") or os.path.join(
    os.environ.get("TEMP", os.path.expanduser("~")), "codex-remote-proxy.log"
)
DEBUG = os.environ.get("CP_DEBUG") == "1"

_ids = iter(range(1, 10**9))


def log(msg):
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write("%.3f %s\n" % (time.time(), msg))
    except Exception:
        pass
    if DEBUG:
        print(msg, flush=True)


# ---------------------------------------------------------------------------
# Registry / config
# ---------------------------------------------------------------------------

def registry():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import rc_common

    rc_common.ensure_registry_dir()
    return rc_common.load_registry()


def cfg_for_token(reg, token):
    if not token:
        return None
    return reg.get(token)


def cfg_for_env_id(reg, env_id):
    for cfg in reg.values():
        if cfg.get("envId") == env_id:
            return cfg
    return None


_live_cache = {"at": 0.0, "val": {}}


def config_pane_state():
    """configName -> 'alive' | 'dead' | 'unknown', cached ~2s."""
    now = time.monotonic()
    if now - _live_cache["at"] < 2.0:
        return _live_cache["val"]
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import rc_common

    val = rc_common.config_pane_state()
    _live_cache["at"] = now
    _live_cache["val"] = val
    return val


# ---------------------------------------------------------------------------
# Path normalization
# ---------------------------------------------------------------------------

def _norm_variants(win_home):
    """All spellings of the Windows local home we should treat as equivalent."""
    wh = win_home.replace("\\", "/")
    out = [
        win_home,
        wh,
        "file:///" + wh,                      # file:///C:/Users/...
        "file://" + wh,
    ]
    # git-bash form: C:/Users/x -> /c/Users/x
    if len(wh) >= 2 and wh[1] == ":":
        out.append("/" + wh[0].lower() + wh[2:])
        out.append("/" + wh[0].upper() + wh[2:])
    return out


def _uri(path):
    """POSIX abs path -> file URI with the correct authority slash."""
    path = path.replace("\\", "/")
    if path.startswith("/"):
        return "file://" + path          # /root -> file:///root
    return "file:///" + path             # C:/Users -> file:///C:/Users


def win_to_posix(s, win_home, remote_home):
    if not isinstance(s, str):
        return s
    out = s
    # Strip file:// and UNC prefixes, then match home variants.
    out = re.sub(r"^file://", "", out)
    out = re.sub(r"^//\?/", "", out)
    # The app-server on Windows normalizes the POSIX cwd to a drive path
    # (e.g. /root -> D:\root or file:///D:/root). Map any drive-prefixed
    # remote cwd back before generic home mapping.
    if remote_home:
        rh = remote_home.lstrip("/")
        for drive in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            for d in (drive, drive.lower()):
                out = out.replace(d + ":\\" + rh, remote_home)
                out = out.replace(d + "\\" + rh, remote_home)
                out = out.replace(d + ":/" + rh, remote_home)
                out = out.replace(d + "/" + rh, remote_home)
    for v in _norm_variants(win_home):
        if v and v in out:
            out = out.replace(v, remote_home)
    if out.startswith("~"):
        out = remote_home + out[1:]
    out = out.replace("\\", "/")
    # Collapse the leading duplicate slash that drive mapping can leave behind.
    if out.startswith("//") and not out.startswith("///"):
        out = "/" + out.lstrip("/")
    return out


def posix_to_win(s, win_home, remote_home):
    if not isinstance(s, str):
        return s
    out = s
    out = re.sub(r"^file://", "", out)
    # Keep forward slashes (git-bash understands C:/Users/...); only map the
    # remote-home / tilde prefixes. Do not rewrite the rest of a command.
    wh = win_home.replace("\\", "/")
    if remote_home and out.startswith(remote_home):
        out = wh + out[len(remote_home):]
    if out.startswith("~"):
        out = wh + out[1:]
    return out


def map_str(node, fn):
    if isinstance(node, list):
        return [map_str(v, fn) for v in node]
    if isinstance(node, dict):
        return {k: map_str(v, fn) for k, v in node.items()}
    if isinstance(node, str):
        return fn(node)
    return node


# ---------------------------------------------------------------------------
# cwd role rewrites
# ---------------------------------------------------------------------------

def rewrite_cwd_role(cfg, text):
    try:
        m = json.loads(text)
    except Exception:
        return text
    p = m.get("params")
    if not isinstance(p, dict):
        return text
    method = m.get("method")
    remote_cwd = cfg.get("remoteCwd", "/root")
    envs = [{"environmentId": cfg["envId"], "cwd": remote_cwd}]
    # Inject only fields each method's schema actually declares. In particular
    # turn/settings/update has deny_unknown_fields and no cwd/approval/sandbox.
    if method == "thread/start":
        p["cwd"] = remote_cwd
        p["environments"] = envs
        p["approvalPolicy"] = "never"
        p["sandbox"] = "danger-full-access"
    elif method == "turn/start":
        p["cwd"] = remote_cwd
        p["environments"] = envs
        p["approvalPolicy"] = "never"
        p["sandboxPolicy"] = {"type": "dangerFullAccess"}
    elif method in ("thread/resume", "thread/fork"):
        p["cwd"] = remote_cwd
        p["approvalPolicy"] = "never"
        p["sandbox"] = "danger-full-access"
    elif method == "thread/settings/update":
        p["cwd"] = remote_cwd
        p["environments"] = envs
        p["approvalPolicy"] = "never"
        p["sandboxPolicy"] = {"type": "dangerFullAccess"}
    else:
        return text
    return json.dumps(m)


def ensure_experimental(text):
    try:
        m = json.loads(text)
    except Exception:
        return text
    if m.get("method") != "initialize":
        return text
    params = m.get("params")
    if not isinstance(params, dict):
        params = {}
        m["params"] = params
    caps = params.get("capabilities")
    if not isinstance(caps, dict):
        caps = {}
        params["capabilities"] = caps
    caps["experimentalApi"] = True
    return json.dumps(m)


# ---------------------------------------------------------------------------
# route role rewrites
# ---------------------------------------------------------------------------

def route_target(cfg, argv):
    """Return 'win' or 'remote'. remoteOverride wins, then local patterns."""
    if not isinstance(argv, list):
        return "remote"
    joined = " ".join(argv)
    for pat in cfg.get("remoteOverride") or []:
        if pat and pat in joined:
            return "remote"
    for pat in (cfg.get("localMatch") or []) + (cfg.get("localWhitelist") or []):
        if pat and pat in joined:
            return "win"
    return "remote"


def rewrite_for_wsl(cfg, text):
    try:
        m = json.loads(text)
    except Exception:
        return text
    p = m.get("params")
    if not isinstance(p, dict):
        return text
    method = m.get("method", "")
    remote_cwd = cfg.get("remoteCwd", "/root")
    win_home = cfg.get("localHome", "C:\\Users")
    remote_home = cfg.get("remoteHome", "/root")
    p["cwd"] = _uri(remote_cwd)
    if isinstance(p.get("argv"), list):
        p["argv"] = [win_to_posix(a, win_home, remote_home) for a in p["argv"]]
    if "sandbox" in p:
        p["sandbox"] = map_str(p["sandbox"], lambda s: win_to_posix(s, win_home, remote_home))
    if "envPolicy" in p:
        p["envPolicy"] = map_str(p["envPolicy"], lambda s: win_to_posix(s, win_home, remote_home))
    # fs/* paths are file:// URIs -> normalize to the remote home.
    if method.startswith("fs/"):
        norm = lambda s: _uri(win_to_posix(s, win_home, remote_home))
        if isinstance(p.get("path"), str):
            p["path"] = norm(p["path"])
        if isinstance(p.get("paths"), list):
            p["paths"] = [norm(x) for x in p["paths"]]
    return json.dumps(m)


def rewrite_for_win(cfg, text):
    try:
        m = json.loads(text)
    except Exception:
        return text
    p = m.get("params")
    if not isinstance(p, dict):
        return text
    win_home = cfg.get("localHome", "C:\\Users")
    remote_home = cfg.get("remoteHome", "/root")
    win_cwd = cfg.get("winCwd") or win_home
    p["cwd"] = "file:///" + win_cwd.replace("\\", "/")
    if isinstance(p.get("argv"), list):
        argv = [posix_to_win(a, win_home, remote_home) for a in p["argv"]]
        if argv and re.search(r"(^|[\\/])(bash|sh|zsh)(\.exe)?$", argv[0]):
            bash_exe = cfg.get("bashExe") or "bash"
            argv = [bash_exe] + argv[1:]
        p["argv"] = argv
    if "sandbox" in p:
        p["sandbox"] = map_str(p["sandbox"], lambda s: posix_to_win(s, win_home, remote_home))
    env = p.get("env")
    if not isinstance(env, dict):
        env = {}
        p["env"] = env
    if cfg.get("winPath"):
        env["PATH"] = cfg["winPath"]
    for k, v in (cfg.get("herdr") or {}).items():
        env[k] = v
    return json.dumps(m)


# ---------------------------------------------------------------------------
# cwd role (TUI side)
# ---------------------------------------------------------------------------

async def cwd_role_handler(ws, path=None):
    auth = None
    try:
        auth = ws.request_headers.get("Authorization")
    except Exception:
        auth = None
    reg = registry()
    token = (auth or "").removeprefix("Bearer ").strip()
    cfg = cfg_for_token(reg, token)
    if cfg:
        log("[cwd] TUI token=%s pane=%s env=%s" % (token[:8], cfg.get("pane"), cfg.get("envId")))
    else:
        log("[cwd] TUI with unrecognized token")
    try:
        up = await connect(UPSTREAM)
    except Exception as e:
        log("[cwd] upstream connect error: %s" % e)
        return

    async def pump_upstream():
        try:
            async for msg in up:
                await ws.send(msg)
        except Exception:
            pass

    asyncio.create_task(pump_upstream())

    sent_add = False
    try:
        async for msg in ws:
            if not sent_add:
                m = None
                try:
                    m = json.loads(msg)
                except Exception:
                    m = None
                if m and m.get("method") == "initialize":
                    sent_add = True
                    await up.send(ensure_experimental(msg))
                    if cfg:
                        add = {
                            "id": "cr-add-%d" % next(_ids),
                            "method": "environment/add",
                            "params": {
                                "environmentId": cfg["envId"],
                                "execServerUrl": "ws://%s:%d/env/%s"
                                % (HOST, PROXY_PORT, cfg["envId"]),
                                "connectTimeoutMs": 15000,
                            },
                        }
                        await up.send(json.dumps(add))
                        log("[cwd] environment/add env=%s url=ws://%s:%d/env/%s"
                            % (cfg["envId"], HOST, PROXY_PORT, cfg["envId"]))
                    else:
                        await up.send(msg)
                    continue
            if cfg:
                await up.send(rewrite_cwd_role(cfg, msg))
            else:
                await up.send(msg)
    finally:
        try:
            await up.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# route role (app-server side)
# ---------------------------------------------------------------------------

class Conn:
    def __init__(self, uri, label):
        self.uri = uri
        self.label = label
        self.sock = None
        self.ready = asyncio.Event()
        self._lock = asyncio.Lock()

    async def ensure(self):
        if self.sock is not None:
            return self.sock
        async with self._lock:
            if self.sock is None:
                try:
                    self.sock = await connect(self.uri)
                    log("[%s] connected -> %s" % (self.label, self.uri))
                except Exception as e:
                    log("[%s] connect error: %s" % (self.label, e))
        return self.sock

    async def close(self):
        sock = self.sock
        self.sock = None
        self.ready.clear()
        if sock is not None:
            try:
                await sock.close()
            except Exception:
                pass

    async def reader(self, ws, own_handshake=False):
        while True:
            await self.ensure()
            if self.sock is None:
                await asyncio.sleep(0.3)
                continue
            if own_handshake and not self.ready.is_set():
                try:
                    init_id = "cr-win-init"
                    await self.sock.send(json.dumps({
                        "id": init_id, "method": "initialize",
                        "params": {"clientName": "codex-remote-proxy"},
                    }))
                    while True:
                        msg = await self.sock.recv()
                        mm = json.loads(msg)
                        if mm.get("id") == init_id:
                            await self.sock.send(json.dumps({"method": "initialized", "params": {}}))
                            self.ready.set()
                            log("[%s] initialized sent" % self.label)
                            break
                        await ws.send(msg)
                except Exception as e:
                    log("[%s] handshake error: %s" % (self.label, e))
                    self.sock = None
                    self.ready.clear()
                    continue
            try:
                while True:
                    msg = await self.sock.recv()
                    try:
                        mm = json.loads(msg)
                        log("[%s] -> app %s" % (self.label, mm.get("method") or ("id=" + str(mm.get("id")))))
                    except Exception:
                        pass
                    await ws.send(msg)
            except Exception as e:
                log("[%s] closed: %s" % (self.label, e))
                self.sock = None
                self.ready.clear()


# How long to keep retrying an upstream connect before failing a request.
CONNECT_DEADLINE_S = 8.0


async def reply_error(ws, m, message, code=-32000):
    """Answer an id-bearing request with a JSON-RPC error so the app-server
    surfaces a failure instead of waiting forever (it maps this to
    ExecServerError::Server). Notifications (no id) cannot be answered."""
    if not isinstance(m, dict) or "id" not in m:
        return
    try:
        await ws.send(json.dumps({"id": m["id"], "error": {"code": code, "message": message}}))
        log("[route] -> app error id=%s: %s" % (m.get("id"), message))
    except Exception:
        pass


async def route_role_handler(ws, path=None):
    path = getattr(ws, "path", None) or path
    reg = registry()
    cfg = None
    if path:
        parsed = urlparse(path)
        env_id = parsed.path.rstrip("/").split("/")[-1] if parsed.path else ""
        if env_id:
            cfg = cfg_for_env_id(reg, env_id)
    if cfg:
        log("[route] app-server connected path=%s pane=%s env=%s" % (path, cfg.get("pane"), cfg.get("envId")))
    else:
        log("[route] app-server connected with unknown env path=%s" % path)

    # One global proxy serves every config; pick this env's remote tunnel from
    # its registry entry (fallback to the proxy's own CP_REMOTE).
    remote_uri = (cfg or {}).get("tunnelUrl") or REMOTE
    remote = Conn(remote_uri, "remote")
    win = Conn(WINDOW, "win")
    remote_task = asyncio.create_task(remote.reader(ws, own_handshake=False))
    win_task = asyncio.create_task(win.reader(ws, own_handshake=True))

    # When this config has no live TUI and the tunnel is gone, stop retrying and
    # close this app-server environment so stale envs do not churn forever.
    remote_name = (cfg or {}).get("configName")

    async def reaper():
        # Require two consecutive "dead" observations so a transient probe
        # failure or a tunnel reconnect for a just-started pane is not fatal.
        dead_streak = 0
        while True:
            await asyncio.sleep(2)
            if remote.sock is not None:
                dead_streak = 0
                continue
            if not remote_name:
                continue
            if config_pane_state().get(remote_name) != "dead":
                dead_streak = 0
                continue
            dead_streak += 1
            if dead_streak < 2:
                continue
            log("[route] env=%s has no live TUI and tunnel is down; closing env"
                % (cfg.get("envId") if cfg else "?"))
            try:
                await ws.close()
            except Exception:
                pass
            return

    reaper_task = asyncio.create_task(reaper())

    pending = {}

    async def ensure_deadline(conn):
        deadline = time.monotonic() + CONNECT_DEADLINE_S
        while True:
            await conn.ensure()
            if conn.sock is not None:
                return True
            if time.monotonic() >= deadline:
                return False
            await asyncio.sleep(0.3)

    async def send_to(conn, text, pid=None, m=None):
        if not await ensure_deadline(conn):
            if m is not None:
                await reply_error(ws, m, "%s exec-server unavailable" % conn.label)
            return False
        try:
            await conn.sock.send(text)
        except Exception as e:
            log("[%s] send error: %s" % (conn.label, e))
            conn.sock = None
            conn.ready.clear()
            if m is not None:
                await reply_error(ws, m, "%s exec-server send failed" % conn.label)
            return False
        if pid:
            pending[pid] = conn.label
        return True

    try:
        async for msg in ws:
            try:
                m = json.loads(msg)
            except Exception:
                await send_to(remote, msg)
                continue
            method = m.get("method", "")
            p = m.get("params") or {}
            log("[route] app->route %s id=%s" % (method, m.get("id")))
            if method in ("initialize", "initialized"):
                await send_to(remote, msg, m=m)
                continue
            if method == "process/start":
                pid = p.get("processId") or p.get("process_id")
                argv = p.get("argv") or []
                if cfg and route_target(cfg, argv) == "win":
                    log("[route] process/start -> WIN argv=%s" % json.dumps(argv)[:200])
                    try:
                        await asyncio.wait_for(win.ready.wait(), timeout=10)
                    except asyncio.TimeoutError:
                        log("[route] win not ready; replying error instead of dropping")
                        await reply_error(ws, m, "local exec-server not ready")
                        continue
                    await send_to(win, rewrite_for_win(cfg, msg), pid, m=m)
                else:
                    log("[route] process/start -> REMOTE argv=%s" % json.dumps(argv)[:200])
                    await send_to(remote, rewrite_for_wsl(cfg or {}, msg), pid, m=m)
                continue
            if method.startswith("process/"):
                pid = p.get("processId") or p.get("process_id")
                target = pending.get(pid, "remote")
                conn = win if target == "win" else remote
                text = rewrite_for_win(cfg, msg) if target == "win" else rewrite_for_wsl(cfg or {}, msg)
                await send_to(conn, text, m=m)
                continue
            if method.startswith("fs/"):
                await send_to(remote, rewrite_for_wsl(cfg or {}, msg), m=m)
                continue
            await send_to(remote, msg, m=m)
    finally:
        # The app-server closed this environment connection: stop its readers
        # and drop the outbound exec-server sockets so they do not reconnect.
        for t in (remote_task, win_task, reaper_task):
            t.cancel()
        await asyncio.gather(remote_task, win_task, reaper_task, return_exceptions=True)
        await remote.close()
        await win.close()


async def dispatch(ws, path=None):
    """Single listener: demux by path. app-server connects to /env/<id> (route
    role); the TUI connects to the root path / (cwd role, bearer-token)."""
    p = getattr(ws, "path", None) or path or "/"
    if p.startswith("/env/"):
        await route_role_handler(ws, p)
    else:
        await cwd_role_handler(ws, p)


async def main():
    if not PROXY_PORT:
        print("CP_PROXY_PORT (or legacy CP_CWD_PORT) is required")
        return
    log("=== codex-remote proxy start port=%d upstream=%s remote=%s window=%s ==="
        % (PROXY_PORT, UPSTREAM, REMOTE, WINDOW))
    server = await serve(dispatch, HOST, PROXY_PORT)
    log("listening proxy=%d (cwd+route demuxed by path)" % PROXY_PORT)
    await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
