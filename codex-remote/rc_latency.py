# Latency probe: time a single process/start round-trip directly against the
# SSH tunnel (raw exec-server) and through the shared proxy route port.
# Usage: python rc_latency.py --config <cfg> [--pane w6:pD] [--n 3]

import argparse
import base64
import json
import os
import sys
import time

from websocket import create_connection

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rc_common


def one(port, path, argv, timeout=40):
    url = "ws://127.0.0.1:%d%s" % (port, path)
    t0 = time.time()
    ws = create_connection(url, timeout=8, suppress_origin=True)
    ws.send(json.dumps({"id": 1, "method": "initialize", "params": {"clientName": "lat"}}))
    # wait init reply
    while True:
        ws.settimeout(8)
        m = json.loads(ws.recv())
        if m.get("id") == 1:
            break
    ws.send(json.dumps({"method": "initialized", "params": {}}))
    t_init = time.time() - t0
    pid = "lat-%d" % int(time.time() * 1000)
    t1 = time.time()
    ws.send(json.dumps({
        "id": 2, "method": "process/start",
        "params": {"processId": pid, "argv": argv, "cwd": "file:///root",
                   "env": {}, "tty": False, "pipeStdin": False},
    }))
    out = []
    t_first = None
    while time.time() - t1 < timeout:
        ws.settimeout(max(0.1, timeout - (time.time() - t1)))
        try:
            m = json.loads(ws.recv())
        except Exception:
            break
        meth = m.get("method")
        if meth == "process/output":
            if t_first is None:
                t_first = time.time() - t1
            p = m.get("params") or {}
            try:
                out.append(base64.b64decode(p.get("chunk", "")).decode("utf-8", "replace"))
            except Exception:
                pass
        elif meth == "process/exited":
            break
    ws.close()
    return t_init, t_first, time.time() - t1, "".join(out).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--pane", default="w6:pD")
    ap.add_argument("--n", type=int, default=3)
    args = ap.parse_args()
    cfg = rc_common.load_config(args.config)
    ports = cfg["ports"]

    env_id = rc_common.make_env_id(cfg, args.pane)
    argv = ["bash", "-lc", "free -h | head -2"]

    print("== direct to SSH tunnel (raw exec-server, no proxy) ==")
    for i in range(args.n):
        ti, tf, tt, out = one(ports["tunnel"], "", argv)
        print("  run%d init=%.2fs first_out=%.2fs exit=%.2fs  out=%r"
              % (i + 1, ti, tf if tf else -1, tt, out[:40]))

    print("== through proxy route port (env=%s) ==" % env_id)
    for i in range(args.n):
        ti, tf, tt, out = one(ports["proxyRoute"], "/env/" + env_id, argv)
        print("  run%d init=%.2fs first_out=%.2fs exit=%.2fs  out=%r"
              % (i + 1, ti, tf if tf else -1, tt, out[:40]))
    return 0


if __name__ == "__main__":
    sys.exit(main())