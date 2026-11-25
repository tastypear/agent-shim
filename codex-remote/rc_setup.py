# Assemble (idempotently) the shared stack and report status. Does NOT launch
# the TUI. Useful for verifying the remote tunnel, local services and proxy.

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rc_common
import rc_launch


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    args = ap.parse_args()
    cfg = rc_common.load_config(args.config)
    rc_common.log("config=%s name=%s" % (args.config, cfg["_name"]))

    rc_common.ensure_local_services(cfg)
    rc_launch.ensure_remote(cfg)

    client = rc_common.connect_ssh(cfg)
    try:
        if not cfg["paths"].get("remoteHome"):
            _rc, out, _ = rc_common.run_ssh(client, "echo $HOME")
            cfg["paths"]["remoteHome"] = out.strip() or "/root"
        rc_common.sync_skills(cfg, client)
        ports = cfg["ports"]
        up = rc_common.remote_port_listening(client, ports["remoteExecServer"])
        rc_common.log("remote exec-server port %d: %s"
                      % (ports["remoteExecServer"], "up" if up else "not found"))
    finally:
        client.close()

    rc_launch.ensure_proxy(cfg)
    rc_common.log("all shared services ready (app=%d proxy=%d tunnel=%d win=%d)"
                  % (ports["appServer"], ports["proxy"], ports["tunnel"],
                     ports["winExecServer"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())