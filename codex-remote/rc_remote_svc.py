# Long-lived remote service: installs/starts the remote exec-server and holds
# the SSH tunnel from the local machine to it. Started detached by the
# launcher if the tunnel port is not already listening.

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rc_common


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    args = ap.parse_args()

    cfg = rc_common.load_config(args.config)
    port = cfg["ports"]["tunnel"]
    name = cfg["_name"]

    if rc_common.port_open(port):
        rc_common.log("remote svc: tunnel port %d already listening; exiting" % port)
        return 0

    while True:
        client = None
        try:
            client = rc_common.connect_ssh(cfg)
            rdir = rc_common.install_remote_exec_server(cfg, client)
            rc_common.start_remote_exec_server(cfg, client, rdir)
            listener, stop = rc_common.open_tunnel(cfg, client, port)
            # Grace period: a launcher starts this service just before it
            # records the new pane's tuiPid, so do not reap on the very first
            # ticks. Only after this window do we trust a "dead" reading.
            started = time.time()
            while True:
                try:
                    client.get_transport().send_ignore()
                except Exception as e:
                    rc_common.log("remote svc: ssh transport dropped: %s; reconnecting" % e)
                    break
                # Drop the tunnel once no TUI for this config is alive (only
                # when we have positively observed all recorded TUIs dead; a
                # config with no recorded pid is left alone).
                if time.time() - started > 10 and rc_common.config_pane_state().get(name) == "dead":
                    rc_common.log("remote svc: no live TUI for %s; closing tunnel" % name)
                    stop.set()
                    try:
                        listener.close()
                    except Exception:
                        pass
                    client.close()
                    return 0
                time.sleep(2)
            stop.set()
            try:
                listener.close()
            except Exception:
                pass
            client.close()
            rc_common.log("remote svc: reconnecting in 3s")
            time.sleep(3)
        except Exception as e:
            rc_common.log("remote svc: error: %s; retry in 5s" % e)
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass
            time.sleep(5)


if __name__ == "__main__":
    main()
