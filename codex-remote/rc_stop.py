# Stop the shared local services for one connection config by their listening
# ports. Only codex.exe / python.exe owners are killed (never node.exe).

import argparse
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rc_common


def port_pids(port):
    pids = set()
    try:
        out = subprocess.check_output(["netstat", "-ano", "-p", "TCP"], text=True)
    except Exception:
        return pids
    token = ":%d" % port
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[1].endswith(token) and parts[3] == "LISTENING":
            try:
                pids.add(int(parts[4]))
            except ValueError:
                pass
    return pids


def proc_name(pid):
    try:
        out = subprocess.check_output(
            ["tasklist", "/FI", "PID eq %d" % pid, "/FO", "CSV", "/NH"], text=True
        )
        line = out.strip().splitlines()[0]
        return line.split(",")[0].strip('"').lower()
    except Exception:
        return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--shared", action="store_true",
                    help="also stop the GLOBAL app-server / Windows exec-server / "
                         "shared proxy (shared by every config)")
    args = ap.parse_args()
    cfg = rc_common.load_config(args.config)
    ports = cfg["ports"]
    # Per-config service: this config's SSH tunnel only (the proxy is global).
    targets = [
        ("remote-svc/tunnel", ports["tunnel"]),
    ]
    if args.shared:
        # Global singletons: stopping them affects ALL connection configs.
        targets += [
            ("app-server(global)", ports["appServer"]),
            ("windows-exec-server(global)", ports["winExecServer"]),
            ("proxy(global)", ports["proxyCwd"]),
            ("proxy(global)", ports["proxyRoute"]),
        ]
    killed = set()
    for label, port in targets:
        for pid in port_pids(port):
            name = proc_name(pid)
            if "codex" not in name and "python" not in name:
                rc_common.log("skip %s pid=%d name=%s (not ours)" % (label, pid, name))
                continue
            if pid in killed:
                continue
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
            killed.add(pid)
            rc_common.log("stopped %s on port %d (pid %d, %s)" % (label, port, pid, name))
    if not killed:
        rc_common.log("no running services found for %s" % args.config)
    if not args.shared:
        rc_common.log("note: global app-server %d, Windows exec-server %d and proxy %d/%d "
                      "are left running; pass --shared to stop them too"
                      % (ports["appServer"], ports["winExecServer"],
                         ports["proxyCwd"], ports["proxyRoute"]))
    rc_common.log("note: the remote exec-server keeps running on the remote host")


if __name__ == "__main__":
    main()