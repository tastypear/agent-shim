# Per-pane launcher: ensure the shared local services (app-server, Windows
# exec-server, shared proxy, remote tunnel), register this pane, then launch
# the official Codex TUI against the shared proxy with a per-pane bearer token.

import argparse
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rc_common


def herdr_env():
    return {k: v for k, v in os.environ.items() if k == "HERDR_ENV" or k.startswith("HERDR_")}


def ensure_remote(cfg):
    port = cfg["ports"]["tunnel"]
    if rc_common.port_open(port):
        return
    rc_common.log("starting remote service (install/start exec-server + tunnel)")
    run_dir = os.path.join(rc_common.RUN, cfg["_name"])
    os.makedirs(run_dir, exist_ok=True)
    rc_common.start_detached(
        [sys.executable, os.path.join(rc_common.HERE, "rc_remote_svc.py"),
         "--config", cfg["_path"]],
        logfile=os.path.join(run_dir, "remote-svc.log"),
    )
    if not rc_common.wait_port(port, timeout=cfg.get("readyTimeout", 15000) / 1000.0 + 30):
        raise SystemExit("remote service did not open tunnel port %d; see %s"
                         % (port, os.path.join(run_dir, "remote-svc.log")))


def ensure_proxy(cfg):
    ports = cfg["ports"]
    if rc_common.port_open(ports["proxyCwd"]) and rc_common.port_open(ports["proxyRoute"]):
        return
    rc_common.log("starting shared proxy cwd=%d route=%d" % (ports["proxyCwd"], ports["proxyRoute"]))
    run_dir = os.path.join(rc_common.RUN, cfg["_name"])
    os.makedirs(run_dir, exist_ok=True)
    rc_common.ensure_registry_dir()
    env = dict(os.environ)
    env.update({
        "CP_CWD_PORT": str(ports["proxyCwd"]),
        "CP_ROUTE_PORT": str(ports["proxyRoute"]),
        "CP_UPSTREAM": "ws://127.0.0.1:%d" % ports["appServer"],
        "CP_REMOTE": "ws://127.0.0.1:%d" % ports["tunnel"],
        "CP_WINDOW": "ws://127.0.0.1:%d" % ports["winExecServer"],
        "CP_REGISTRY": rc_common.REGISTRY,
        "CP_LOG": os.path.join(run_dir, "proxy.log"),
    })
    rc_common.start_detached(
        [sys.executable, os.path.join(rc_common.HERE, "rc_proxy.py")],
        env=env,
        logfile=os.path.join(run_dir, "proxy.stdout.log"),
    )
    if not (rc_common.wait_port(ports["proxyCwd"]) and rc_common.wait_port(ports["proxyRoute"])):
        raise SystemExit("proxy did not start; see %s" % os.path.join(run_dir, "proxy.stdout.log"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("rest", nargs=argparse.REMAINDER)
    args = ap.parse_args()

    cfg = rc_common.load_config(args.config)
    exe = rc_common.resolve_codex_exe(cfg)
    cfg["codex"]["exe"] = exe

    local_home = cfg["codex"].get("localHome") or os.path.expanduser("~")
    cfg["codex"]["localHome"] = local_home

    # Remote is required for install/start/tunnel and for home detection + sync.
    ensure_remote(cfg)

    # Detect remote home and sync skills over one short SSH session.
    client = rc_common.connect_ssh(cfg)
    try:
        remote_home = cfg["paths"].get("remoteHome") or ""
        if not remote_home:
            rc, out, _ = rc_common.run_ssh(client, "echo $HOME")
            remote_home = out.strip() or "/root"
            cfg["paths"]["remoteHome"] = remote_home
        rc_common.sync_skills(cfg, client)
    finally:
        client.close()

    rc_common.ensure_local_services(cfg)
    ensure_proxy(cfg)

    pane = os.environ.get("HERDR_PANE_ID") or "nopane"
    env_id = rc_common.make_env_id(cfg, pane)
    token = rc_common.make_token(cfg, pane)
    remote_cwd = cfg["paths"].get("vcwd") or cfg["paths"]["remoteHome"] or "/root"
    win_cwd = local_home
    win_path = cfg["exec"].get("localPath") or ""
    if os.environ.get("PATH"):
        win_path = (win_path + ";" + os.environ["PATH"]) if win_path else os.environ["PATH"]

    entry = {
        "token": token,
        "envId": env_id,
        "pane": pane,
        "configName": cfg["_name"],
        "tunnelUrl": "ws://127.0.0.1:%d" % cfg["ports"]["tunnel"],
        "remoteCwd": remote_cwd,
        "remoteHome": cfg["paths"]["remoteHome"] or "/root",
        "localHome": local_home,
        "winCwd": win_cwd,
        "winPath": win_path,
        "bashExe": rc_common.resolve_bash(cfg),
        "herdr": herdr_env(),
        "localMatch": cfg["exec"].get("localMatch") or ["herdr "],
        "localWhitelist": cfg["exec"].get("localWhitelist") or [],
        "remoteOverride": cfg["exec"].get("remoteOverride") or [],
        "yolo": cfg.get("yolo", True),
    }
    path = rc_common.write_registry(entry)
    rc_common.log("registered pane=%s envId=%s token=%s" % (pane, env_id, token[:8]))

    token_env = "CODEX_REMOTE_TOKEN"
    env = dict(os.environ)
    env[token_env] = token
    url = "ws://127.0.0.1:%d" % cfg["ports"]["proxyCwd"]
    argv = [exe, "--remote", url, "--remote-auth-token-env", token_env] + list(args.rest)
    rc_common.log("launching TUI: %s" % " ".join(argv))
    proc = subprocess.Popen(argv, env=env)
    # Record the TUI pid so the remote service can drop the SSH tunnel once
    # this pane's TUI exits.
    entry["tuiPid"] = proc.pid
    rc_common.write_registry(entry)
    return proc.wait()


if __name__ == "__main__":
    sys.exit(main())