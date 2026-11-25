# codex-remote

Run the **official Codex TUI locally on Windows** while its **commands and files
execute on a remote Linux host**. The heavy work (model, context, history, auth)
stays local in `~/.codex`; the remote only runs a lightweight `exec-server`, so
low-spec machines need no Codex install or login.

All components are Python (no Node). Topology, per connection config:

```
local Windows                                  remote Linux (via SSH)
  codex TUI ──► shared proxy (1 port)  ──┐
                    │  path / + bearer -> pane│
                    ▼                       │
             single app-server  ────────────┼──► shared proxy (same port)
             (local ~/.codex)               │        │ /env/<id> -> pane
                                            │        ├─► remote exec-server  (default)
                                            │        └─► Windows exec-server (local allow-list)
                                            └── SSH tunnel (direct-tcpip)
```

Processes are shared and long-lived, and **not** per pane:

- **global** (one each, shared by every connection config): `app-server`, the
  Windows `exec-server`, and the `proxy` (a single port demuxes the TUI side
  by path `/` + bearer token and the app-server side by `/env/<id>`). The
  first launch fixes their ports in `.run/global.json`; later configs reuse
  them.
- **per remote config**: one SSH `tunnel` (the proxy dials this env's tunnel,
  chosen from the pane's registry `tunnelUrl`).
- **per remote host**: one `exec-server` (runs on that host, not local).
- **per pane**: one TUI plus one registry entry.

So the local process count is `3 (global) + (number of remote configs)`,
independent of how many panes you open.

## Quick start

1. Copy `config.example.json` to `../.agent-shim-codex-<name>-ssh.json` and fill
   in `ssh`, `codex.exe`, `codex.localHome`. For several remotes at once, give
   each config a distinct `tunnel` and `remoteExecServer`; `appServer`,
   `winExecServer` and `proxy` are global and shared (the first launch's
   values are stored in `.run/global.json`).
2. Launch from any terminal (PowerShell shown):

   ```powershell
   $env:CODEX_REMOTE_CONFIG="D:\path\to\.agent-shim-codex-<name>-ssh.json"
   D:\program\agent-shim\codex-remote\codex-remote.cmd
   ```

   With no `CODEX_REMOTE_CONFIG`, it uses `../.agent-shim-codex-wsl-ssh.json`.

The launcher is idempotent: it starts the shared services if absent, installs
or reuses the remote `exec-server` (arch-aware: x86_64 / aarch64, content
addressed by sha256), syncs `~/.codex/skills`, registers this pane, then starts
the TUI against the proxy with a per-pane bearer token.

## Tunnel lifetime

The launcher records each pane's TUI pid in the registry. The per-config
tunnel service checks every ~2s; once it has positively observed that **all**
recorded TUIs for that config are dead (after a short startup grace), it
closes the SSH tunnel and exits. The proxy then closes the now-orphaned
app-server environments so they stop reconnecting. The next launch restarts
the tunnel automatically. A config whose registry has no recorded pid is left
alone (treated as "unknown", never reaped).

Every launch appends a unique suffix to its pane id (`<pane|local>-<rand>`),
because herdr pane ids are only unique within one herdr server and plain
terminal windows have none. So envId/token/registry entries never collide
across windows or restarts, and the tunnel is closed only once all of a
config's TUIs have exited.

## Stop

```
codex-remote-stop.cmd            # this config's tunnel only
codex-remote-stop.cmd --shared   # also stop the GLOBAL app-server / Windows exec-server / proxy
```

The global app-server, Windows exec-server and proxy are shared by every
config, so `--shared` affects all of them. The remote exec-server keeps
running on the remote host.

## Files

| File | Purpose |
|---|---|
| `rc_common.py` | config load, SSH (paramiko, optional SOCKS5), arch-aware remote install/start, full-duplex tunnel, skills sync, registry |
| `rc_proxy.py` | shared two-port proxy: cwd role (bearer token -> pane) and route role (`/env/<id>` -> pane); routing, path normalization, yolo |
| `rc_remote_svc.py` | long-lived remote service: install/start exec-server + hold the SSH tunnel |
| `rc_launch.py` | per-pane launcher: assemble -> register -> start TUI |
| `rc_setup.py` | assemble shared services without launching the TUI (status check) |
| `rc_test.py` | self-test through the proxy (env registration, remote + local routing) |
| `rc_latency.py` | round-trip latency probe (direct tunnel vs through proxy) |
| `rc_stop.py` | stop local services by listening port (kills only codex/python) |
| `codex-remote.cmd` / `.ps1` / `codex-remote-stop.cmd` | Windows entry points |
| `config.example.json` | sample connection config |

## Routing (`exec` section)

Applied only to `process/start`. Everything else (including `fs/*` file tools)
always goes to the remote.

- `remoteOverride` — substring match; **highest priority**, forces remote.
- `localMatch` / `localWhitelist` — substring match (Python `in`, case
  sensitive, no regex); either hit routes to the Windows exec-server. Default
  `localMatch` is `["herdr "]` (note the trailing space so a path segment named
  `herdr` does not match; `herdr pane list` still does).
- Default with no match: remote.

Local-routed commands get this pane's `HERDR_*` plus a Windows `PATH` injected.

## Notes / limits

- Mixed/composite commands are not split; a command runs entirely on one side.
- Paths are normalized one way (Windows -> POSIX) for remote commands only;
  command output is never rewritten.
- `.codex` sync copies only `skills/` (never auth, history, DBs, packages).
- Remote `exec-server` runs with a private `CODEX_HOME` (`/opt/codex-remote/home`).
- Not implemented: herdr `SessionStart` per-pane session reporting.
