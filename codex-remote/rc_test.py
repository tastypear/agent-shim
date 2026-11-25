# Self-test through the shared proxy (no TUI). Verifies:
#   1. environment registration via the cwd role (token -> envId -> app-server)
#   2. remote routing (process/start -> Linux exec-server through the tunnel)
#   3. local routing (herdr argv -> Windows exec-server, HERDR_* injected)

import argparse
import json
import os
import sys
import time

from websocket import create_connection

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rc_common


def recv_until(ws, match, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        ws.settimeout(max(0.1, deadline - time.time()))
        try:
            m = json.loads(ws.recv())
        except Exception:
            return None
        if match(m):
            return m
    return None


def fake_tui(cwd_port, token, env_id):
    ws = create_connection(
        "ws://127.0.0.1:%d" % cwd_port, timeout=5, header={"Authorization": "Bearer " + token}
    )
    ws.send(json.dumps({"id": 1, "method": "initialize",
                        "params": {"clientInfo": {"name": "probe", "version": "0"},
                                   "capabilities": {"experimentalApi": False}}}))
    ws.send(json.dumps({"method": "initialized", "params": {}}))
    recv_until(ws, lambda m: m.get("id") == 1, timeout=8)
    ws.send(json.dumps({"id": 2, "method": "environment/status",
                        "params": {"environmentId": env_id}}))
    res = recv_until(ws, lambda m: m.get("id") == 2, timeout=10)
    ws.close()
    return res


def run_process(route_port, env_id, argv, label, timeout=25):
    ws = create_connection("ws://127.0.0.1:%d/env/%s" % (route_port, env_id), timeout=5)
    ws.send(json.dumps({"id": 1, "method": "initialize", "params": {"clientName": "probe"}}))
    if recv_until(ws, lambda m: m.get("id") == 1, timeout=8) is None:
        print("[%s] NO initialize response" % label)
        ws.close()
        return
    ws.send(json.dumps({"method": "initialized", "params": {}}))
    time.sleep(0.3)
    pid = "probe-" + label
    ws.send(json.dumps({
        "id": 2, "method": "process/start",
        "params": {"processId": pid, "argv": argv, "cwd": "file:///root",
                   "env": {}, "tty": False, "pipeStdin": False},
    }))
    import base64
    out = {"stdout": [], "stderr": []}
    deadline = time.time() + timeout
    while time.time() < deadline:
        ws.settimeout(max(0.1, deadline - time.time()))
        try:
            raw = ws.recv()
        except Exception as e:
            print("[%s] no process/exited (%s)" % (label, e))
            ws.close()
            return
        m = json.loads(raw)
        method = m.get("method")
        if method == "process/output":
            p = m.get("params") or {}
            try:
                chunk = base64.b64decode(p.get("chunk", "")).decode("utf-8", "replace")
            except Exception:
                chunk = ""
            out.setdefault(p.get("stream", "stdout"), []).append(chunk)
        elif method == "process/exited":
            p = m.get("params") or {}
            print("[%s] EXITED exitCode=%s" % (label, p.get("exitCode")))
            print("[%s] stdout=%s" % (label, "".join(out.get("stdout", [])).strip()))
            print("[%s] stderr=%s" % (label, "".join(out.get("stderr", [])).strip()))
            ws.close()
            return
    print("[%s] timed out waiting for exit" % label)
    ws.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--pane", default="TEST-PANE")
    args = ap.parse_args()
    cfg = rc_common.load_config(args.config)
    ports = cfg["ports"]

    pane = args.pane
    env_id = rc_common.make_env_id(cfg, pane)
    token = rc_common.make_token(cfg, pane)
    local_home = cfg["codex"].get("localHome") or os.path.expanduser("~")
    entry = {
        "token": token, "envId": env_id, "pane": pane,
        "configName": cfg["_name"],
        "tunnelUrl": "ws://127.0.0.1:%d" % cfg["ports"]["tunnel"],
        "remoteCwd": cfg["paths"].get("vcwd") or "/root",
        "remoteHome": cfg["paths"].get("remoteHome") or "/root",
        "localHome": local_home, "winCwd": local_home,
        "winPath": cfg["exec"].get("localPath") or os.environ.get("PATH", ""),
        "bashExe": rc_common.resolve_bash(cfg),
        "herdr": {"HERDR_PANE_ID": pane, "HERDR_ENV": "test"},
        "localMatch": cfg["exec"].get("localMatch") or ["herdr "],
        "localWhitelist": cfg["exec"].get("localWhitelist") or [],
        "remoteOverride": cfg["exec"].get("remoteOverride") or [],
        "yolo": True,
    }
    rc_common.write_registry(entry)

    print("== 1) register environment via cwd role ==")
    st = fake_tui(ports["proxyCwd"], token, env_id)
    print("environment/status:", json.dumps(st.get("result") if st else None))

    print("== 2) remote routing ==")
    run_process(ports["proxyRoute"], env_id,
                ["bash", "-lc", "uname -s; echo REMOTE_HOME=$HOME"], "remote", timeout=90)

    print("== 3) local (herdr) routing ==")
    run_process(ports["proxyRoute"], env_id,
                ["bash", "-lc", "echo LOCAL_PANE=$HERDR_PANE_ID; echo LOCAL_ENV=$HERDR_ENV"],
                "local")
    return 0


if __name__ == "__main__":
    sys.exit(main())