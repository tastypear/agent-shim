# codex-remote-go

The Go implementation of the Codex-on-Remote adapter: run the **official Codex
TUI on the local host** while its **commands and file operations execute on a
remote Linux host**.

This replaces the Python `codex-remote/` stack. It is a single static binary,
keeps the same protocol and mostly the same config schema, and removes the
per-remote tunnel process.

## What changed vs. the Python version

| | Python (`codex-remote/`) | Go (`codex-remote-go/`) |
|---|---|---|
| Processes | `3 + N` (one SSH tunnel process per remote) | **3** (app-server + local exec-server + proxy), independent of remotes/panes |
| Local TCP ports | `3 + N` | **2** (proxy + local exec-server); app-server uses a Unix socket |
| SSH transport | local TCP listener + pump per remote | `ssh.Client.Dial` returns a `net.Conn`; WebSocket dials directly over it |
| Identity | registry file keyed by token | self-describing HMAC token (`cr1.` / `cr1z.`), config read from disk on demand |
| Path mapping | ad-hoc string replace | one typed `Mapper` + table-driven tests |
| Routing | substring over joined argv | command-token / env-reference matching |
| Tunnel lifetime | pid polling in a separate service | in-process connection refcount + idle grace |
| Dependencies | Python + paramiko + websockets + venv | none (one `.exe`) |

The registry file is still written, but only for `tuiPid` bookkeeping and for
compatibility with tooling that inspects it. Routing never depends on it.

## Build

```powershell
cd C:\path\to\codex-remote-go
go build -o codex-remote.exe ./cmd/codex-remote
```

`go test ./...` runs the table-driven path/routing/token tests plus an
in-process proxy integration suite (fake app-server and exec-servers, no SSH
needed).

### Release binaries

```powershell
.\scripts\build-release.ps1 -Version 1.0.0
```

```bash
./scripts/build-release.sh 1.0.0
```

Both produce static `CGO_ENABLED=0` binaries in `dist/` with fixed names:

| Platform | File |
|---|---|
| Windows x64 | `codex-remote-windows-amd64.exe` |
| Windows arm64 | `codex-remote-windows-arm64.exe` |
| Linux x64 | `codex-remote-linux-amd64` |
| Linux arm64 | `codex-remote-linux-arm64` |
| macOS Intel | `codex-remote-darwin-amd64` |
| macOS Apple Silicon | `codex-remote-darwin-arm64` |

The version is embedded with `-ldflags "-X main.version=..."`, so
`codex-remote version` reports the release tag without changing the file name.
On Linux and macOS, run `chmod +x` on the downloaded binary first.

## Launch

```powershell
$env:CODEX_REMOTE_CONFIG = "C:\path\to\codex-remote.json"
.\codex-remote.exe launch --config $env:CODEX_REMOTE_CONFIG
# or the drop-in wrappers
.\codex-remote.cmd
```

`--` separates Codex's own arguments:

```powershell
.\codex-remote.exe launch --config $cfg -- --model gpt-5.1
```

Other commands:

| Command | Purpose |
|---|---|
| `setup` | install/start the remote exec-server, sync skills, start the proxy (no TUI) |
| `test` | end-to-end self-test through the proxy (remote, local, `fs/*`) |
| `token` | mint a token for a fake/manual TUI (`--env-file` writes it) |
| `stop` | drop this config's SSH tunnel |
| `stop --shared` | also stop the global app-server / local exec-server / proxy |

Command options:

| Command | Options |
|---|---|
| `launch` | `--config <file>`, `--no-tui`, `-- <codex args>` |
| `proxy` | `--config <file>` |
| `setup` | `--config <file>` |
| `stop` | `--config <file>`, `--shared` |
| `test` | `--config <file>`, `--pane <id>` |
| `token` | `--config <file>`, `--pane <id>`, `--env-file <path>` |

`-c <config>` and `--stop` are accepted as aliases for compatibility.
`stop` also exits the proxy when no TUI is left, matching the old
"`--stop` closes itself" behaviour.

### Local non-Windows

The same binary can run inside WSL or another local Linux host. Build it for
the local platform and point `codex.exe` at the local codex binary; the field
name is kept for config compatibility, but the value may be a POSIX path such
as `/usr/local/bin/codex`. `paths.localHome`, `exec.localPath`, and
`homeAliases.local` use the local host's paths.

```bash
cd /path/to/codex-remote-go
go build -o codex-remote-linux-amd64 ./cmd/codex-remote
./codex-remote-linux-amd64 launch --config /path/to/config.json
```

macOS binaries are built for both `amd64` and `arm64`, but have not been
verified on real hardware yet. Treat them as experimental: they use `zsh` when
available, `lsof` for port ownership, and the macOS `platformOs` value. Linux
`exec-server` targets remain the supported remote side.

## Architecture

```
local host                                         remote Linux (SSH)
  codex TUI ──ws/Bearer──► proxy :19101
                               ├── unix:.run/app-server/app.sock ──► app-server
                               │        └── /env/<envId> ──► proxy :19101
                               ├── /env/<envId> ──► ssh.Client.Dial ──► exec-server :19104
                               └── local allow-list ──► local exec-server :19200
```

- **Two local TCP listeners**: the proxy is demuxed by path (`/env/<id>` is the
  app-server side, everything else is the TUI side with
  `Authorization: Bearer`); the local exec-server serves local-routed commands.
  The app-server itself listens on a private Unix socket, and the
  remote `19104` is inside the remote host and reached over SSH, not a local
  listener.
- The proxy is a **global singleton**, started detached by the launcher and
  shared by every config and pane.
- Each TUI launch mints a fresh token; the env id is stable per config + pane.
  Two local shells using the same config therefore never collide.

### Identity: self-describing tokens

The token carries everything routing needs: config path/name, pane, remote cwd
and home, local home, local PATH, the pane's captured environment, and the
routing lists. It is HMAC-SHA256 signed (`cr1.` plain, `cr1z.` deflate-packed,
because PATH alone can exceed header limits). The key lives in
`.run/token.key`.

The app-server gets the same token via `environment/add.authBearerToken`, so it
replays it on every reconnect. Consequences:

- the proxy needs no registry lookup to route,
- a proxy restart loses nothing while a TUI is alive (TUI reconnects with the
  same token within its 120 s budget),
- `configPath` is re-read from disk per connection, so config edits take effect
  on the next connection.

This is why the current design still uses Bearer. If the TUI were moved to a
`--remote unix://` socket, the stock TUI has no header/query carrier for those
claims (its remote path must be `/`), so identity would have to come from a
per-pane socket path plus a registry/state file. That would trade a small
amount of state for zero port reduction: the proxy still needs a TCP listener
for the app-server's `/env/<id>` WebSocket, because `execServerUrl` only
supports `ws://`/`wss://`. Keeping Bearer on the cwd leg is therefore both more
stateless and no worse on port count.

### SSH without a tunnel process

```go
conn, _ := sshClient.Dial("tcp", "127.0.0.1:19104")   // net.Conn
d := websocket.Dialer{NetDialContext: func(...) (net.Conn, error) { return conn, nil }}
```

No local listener, no pump, no half-duplex stall. The `net.Conn` wrapper
absorbs `SetDeadline` because SSH channels do not support deadlines.

### Lifecycle

- The shared app-server listens on `.run/app-server/app.sock`; the directory is
  set to owner-only ACLs before codex starts it. Its pid is recorded in
  `.run/app-server.pid` so `stop --shared` can stop it by PID.
- Each config gets one lazily-created SSH client, reference-counted by live TUI
  connections. When the last TUI for an env disconnects, the exec-server leg is
  dropped and, after `proxy.idleGraceSec`, the SSH client is closed.
- The app-server's environment connection is **not** closed on TUI exit (that
  only makes it reconnect forever). If it reconnects with no live TUI, the proxy
  keeps it but refuses to rebuild SSH; requests get a JSON-RPC error.
- If the proxy itself dies, the TUI reconnects, `environment/add` is replayed,
  and the SSH tunnel is rebuilt on demand.

## Reconnect and failure behaviour

| Situation | Current behaviour |
|---|---|
| Laptop sleeps / network is gone for minutes | The TUI stays open and reconnects to the local proxy. A turn that was in flight when the SSH/WebSocket died fails (`transport disconnected`); after the network returns, new turns work. The remote exec-server keeps running, but the old turn's missing output is not replayed by a fresh exec-server session. |
| Proxy crashes and is restarted | The TUI reconnects with the same token, re-sends `initialize` and `environment/add`, and the proxy rebuilds SSH on demand. An app-server that reconnects `/env` before its TUI gets a short grace period; if the TUI appears, the placeholder is closed so the app-server retries with a real route. |
| TUI exits with Ctrl+C | The live-connection count drops to zero, the remote legs are dropped, and the SSH client is closed after `idleGraceSec` (default 20--30 s). The app-server environment is left as an orphan instead of triggering a reconnect loop. |
| TUI is relaunched in the same shell | The env id is derived from config + pane, so it is stable and `environment/add` upserts the same environment. A new pane gets a fresh id. |
| Two local shells use the same config | The token carries a per-pane env id and a per-pane environment snapshot; the integration test has two panes concurrently routed to distinct local environments. |
| First launch is slow (install/sync) | The launcher performs remote setup before it starts the TUI. The proxy has no PID polling or "TUI not seen yet" kill path. |
| Long outage | Redials are single-flight per environment and exponentially backed off; a reachable host probe clears the backoff early. In the 60 s simulated outage test this produced five dial attempts, not a connect storm. |

## Routing

`process/start` is routed; everything else goes remote.

- `remoteOverride` wins (forces remote).
- `localMatch` / `localWhitelist` route to the local exec-server.
- Default is remote.

Matching is token-based, not substring-based:

- the command name (`argv[0]` basename), and the first word of a `bash -lc`
  script,
- whole tokens inside the script (split on `; | & ( )`),
- `$HERDR_*` / `${HERDR_*}` / `HERDR_*` references for prefix patterns.

`"herdr "` (with trailing space) still means "the command `herdr`", so
`.../skills/herdr/SKILL.md` does not match.

Local-routed commands get the pane's captured environment plus the local
`PATH` injected through `ExecParams.env` (the exec-server's highest-priority
overlay).

## Path handling

One-way, inputs only, command output is never rewritten:

- `C:\x`, `C:/x`, `file:///C:/x`, `file://C:/x`, `\\?\C:\x`, `/c/x` → normalized,
- `<localHome>` ↔ `<remoteHome>` prefix mapping,
- app-server's drive-mangled cwd (`D:\root`) → `/root`,
- replacements are token-bounded, so a literal `D:/root` in unrelated text
  survives.

Covered fields: `argv`, `cwd`, `sandbox`, `envPolicy`, `path`, `paths`,
`sourcePath`, `destinationPath`, `missing`, `present`.

### Home aliases

`exec.canonicalizeHome` (default `false`) enables configurable home spellings.
The lists describe each side's home; they are not direct from/to replacement
pairs:

```json
{
  "exec": {
    "canonicalizeHome": true,
    "homeAliases": {
      "local": [
        "C:\\Users\\me",
        "C:/Users/me",
        "/c/Users/me"
      ],
      "remote": [
        "/root",
        "/home/me"
      ]
    }
  }
}
```

- Target local: remote home spellings (`remote`) become the actual
  `codex.localHome` path.
- Target remote: local home spellings (`local`) become the actual
  `paths.remoteHome` path.
- Matching is bounded to path components; `/rootfs` is not rewritten.
- `~` and `$HOME` are left alone: the target shell expands them correctly.
- Non-home absolute paths (`/etc`, `/opt`, `C:\Program Files`, ...) are not
  translated. If a command mixes resources that are not mirrored, split it or
  use a remote/local override.

## yolo injection

Only fields each method's schema declares are injected:

| Method | cwd | environments | approval | sandbox |
|---|---|---|---|---|
| `thread/start` | ✓ | ✓ | ✓ | `sandbox:"danger-full-access"` |
| `thread/resume` / `thread/fork` | ✓ | | ✓ | `sandbox` |
| `turn/start` | ✓ | ✓ | ✓ | `sandboxPolicy:{type:"dangerFullAccess"}` |
| `thread/settings/update` | ✓ | ✓ | ✓ | `sandboxPolicy` |
| `turn/settings/update` | untouched (`deny_unknown_fields`) | | | |

## Remote exec-server

- Version is resolved from the local `codex --version` unless
  `codex.execServerVersion` pins it; `strictVersion` turns a mismatch into an
  error instead of a warning.
- The tarball is cached at `.cache/exec-server/<ver>/<arch>/`, uploaded with
  SFTP, sha256-verified, and unpacked to
  `/opt/codex-remote/runtimes/codex/<ver>-linux-<arch>/`.
- An already-listening server is reused only if `/proc/<pid>/exe` is the pinned
  binary; otherwise it is stopped **by pid** (found via `/proc/*/cmdline`) and
  restarted. The Linux musl build reports `executorVersion: "0.0.0"` from
  `initialize` (the local build reports the real version), so the protocol
  cannot be used for this check on the remote side.
- It runs with a private `CODEX_HOME` (`/opt/codex-remote/home`, 0700).
- Port detection understands `ss`, `netstat`, and `/proc/net/tcp` (LISTEN only —
  a TIME_WAIT peer otherwise looks like a listener).

The remote side deliberately stays a persistent `ws://` daemon rather than
`exec-server --listen stdio`. stdio works and would remove the remote port, but
the exec-server would then be an SSH child: sleep/disconnect kills the process,
the session id, running commands, and accumulated output. The daemon is what
makes the "leave the TUI open overnight, resume after sleep" case possible.

## Ports

The current local footprint is:

| Listener | Transport | Purpose |
|---|---|---|
| proxy (`19101` by default) | TCP WebSocket | TUI cwd role and app-server `/env/<id>` route role |
| local exec-server (`19200`) | TCP WebSocket | local-routed commands and `fs/*` |
| app-server | Unix socket | shared app-server, reachable only through the proxy |

The remote exec-server (`19104`) listens only on the remote loopback. It is not
a local port and is reached through `ssh.Client.Dial`.

## Skills sync

Only `skills/` is mirrored to `<remoteHome>/.codex/skills`, content-addressed by
a sha256 manifest in `.digest`. Junctions (e.g. a skill linked from a shared
library) are followed and de-duplicated; `auth.json`, `.env*`, `*.pem`, `id_*`,
`.git`, `node_modules` are excluded.

## Config

See `config.example.json` for a Windows-local setup and
`config.example-linux.json` for a Linux/WSL-local setup. New sections:

```json
{
  "ssh": { "knownHosts": "", "strictHostKey": false, "socksProxy": "" },
  "exec": {
    "canonicalizeHome": true,
    "homeAliases": {
      "local": ["C:\\Users\\me", "/c/Users/me"],
      "remote": ["/root"]
    },
    "envPrefixes": ["HERDR_"],
    "envInclude": [],
    "envExclude": ["CODEX_REMOTE_TOKEN"],
    "inheritEnv": false,
    "env": {}
  },
  "proxy": { "idleGraceSec": 30, "debug": false },
  "remote": {
    "privateHome": "/opt/codex-remote/home",
    "installRoot": "/opt/codex-remote/runtimes/codex",
    "restartOnVersionMismatch": true
  }
}
```

`exec.envPrefixes` generalizes the old hardcoded `HERDR_*` handling: anything
matching a prefix (plus `envInclude`, minus `envExclude`, or everything when
`inheritEnv` is true) is snapshotted into the token and injected into local
commands.

`ports.appServer` is still accepted and written to `.run/global.json` for
compatibility with old configs, but the Go implementation ignores it: the
app-server listener is now a private Unix socket.

`ports.localExecServer` is the local exec-server port. The older
`ports.winExecServer` key is still accepted as a compatibility alias.

## SSH security

- `known_hosts` is verified when present; `strictHostKey: true` refuses unknown
  hosts.
- Without a `known_hosts` entry, trust-on-first-use pins the key **for the
  process** and still rejects a changed key.
- Password and key auth, optional passphrase, optional SOCKS5 for the SSH dial.

## Environment variables

| Variable | Purpose |
|---|---|
| `CODEX_REMOTE_CONFIG` | default config path |
| `CODEX_REMOTE_RUN` | override `.run/` |
| `CODEX_REMOTE_CACHE` | override `.cache/` |
| `CODEX_REMOTE_TOKEN_KEY_FILE` | override the token signing key |

## Known limits

- Composite commands are not split; a command runs entirely on one side.
- Mixed commands that touch both sides (e.g. `herdr ... && uname`) get the wrong
  data on one side; the agent usually self-corrects.
- A turn that is in flight when the network disappears is not retried by the
  app-server. Reconnecting restores the session and new turns, but cannot make
  the old turn's missing output appear.
- `thread/settings/update` is passed through untouched, so it will not force
  `cwd` if the TUI sends a different one.
- The remote exec-server is left running after `stop` (by design).
- Legacy registry entries written by the Python launcher are still readable
  (`configPath` is inferred from `configName`).
