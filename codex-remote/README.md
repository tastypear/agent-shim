# codex-remote

Run the **official Codex TUI locally on Windows** while its **commands and files
execute on a remote Linux host**. The heavy work (model, context, history, auth)
stays local in `~/.codex`; the remote only runs a lightweight `exec-server`, so
low-spec machines need no Codex install or login.

All components are Python (no Node). Topology, per connection config:

```
local Windows                                  remote Linux (via SSH)
  codex TUI ──► shared proxy (cwd port)  ──┐
                    │  bearer token -> pane │
                    ▼                       │
             single app-server  ────────────┼──► shared proxy (route port)
             (local ~/.codex)               │        │ /env/<id> -> pane
                                            │        ├─► remote exec-server  (default)
                                            │        └─► Windows exec-server (local allow-list)
                                            └── SSH tunnel (direct-tcpip)
```

Processes are shared and long-lived: `1 app-server + 1 proxy + 1 Windows
exec-server + 1 tunnel`, independent of how many panes you open. Each pane adds
one TUI and one registry entry.

## Quick start

1. Copy `config.example.json` to `../.agent-shim-codex-<name>-ssh.json` and fill
   in `ssh`, `codex.exe`, `codex.localHome`, and (optionally) a different
   `ports` block per remote so several remotes can run side by side.
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
