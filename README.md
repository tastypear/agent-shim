# agent-shim

A Node.js `--require` preload that lets a Node-based AI agent CLI running on Windows
transparently operate a **remote Linux machine** over SSH (ssh2 SFTP + exec). The agent
perceives a Linux environment — `process.platform === "linux"`, posix paths, a remote
`HOME` — while every `fs` / `child_process` call is routed to the remote.

Built for [Qoder](https://qoder.com); designed to adapt to other Node-based agents (e.g.
[Pi](https://github.com/earendil-works/pi)) via a small adapter interface.

## How it works

Load it before the agent:

```bash
node --require /path/to/agent-shim/lib/index.js /path/to/qodercli.js
```

At startup, agent-shim:

1. Patches `path`, `process.platform`, `os.release()`, `HOME`, and `cwd` so the agent sees Linux.
2. Opens a single SSH connection (optionally through a SOCKS5 proxy) and spins up a worker
   thread with a `SharedArrayBuffer` for **synchronous** SFTP ops (`Atomics.wait`/`notify`).
3. Patches `fs` (`*Sync`, async, `promises`, streams, fd ops) and `child_process`
   (`spawn`/`exec`/`execFile` × sync/async) to route remote-qualified calls through SFTP/SSH.
4. Probes the remote `HOME` and `uname -r` once, caching to disk so subsequent launches are fast.

**Fail-closed by design:** if the SFTP worker isn't ready or dies, remote ops throw —
agent-shim never falls back to spawning per-op `ssh` processes (the original connection-storm
root cause). Concurrency runs over multiple channels on the single connection, not multiple
connections.

## Configuration

agent-shim looks for a config file in this order (first existing file wins):

1. `AGENT_SHIM_CONFIG` env (explicit path; errors if set but missing).
   `REMOTE_BRIDGE_CONFIG` is accepted as a deprecated alias (warns).
2. `cwd/.agent-shim.json`
3. `agent-shim install dir/.agent-shim.json`
4. `~/.config/agent-shim/config.json` (XDG — survives project directory changes)
5. `cwd/.remote-bridge.json` (deprecated, warns)
6. `agent-shim install dir/.remote-bridge.json` (deprecated, warns)
7. `remote-default.json` (tracked, generic defaults)

Per-field env vars (`REMOTE_BRIDGE_HOST`, etc.) override file values. See
[`.agent-shim.example.json`](.agent-shim.example.json) for the full template.

Required: `ssh.host`, `ssh.user`, `paths.vcwd`. Unknown keys warn; type mismatches throw.

### Example

```json
{
  "ssh": { "host": "your-host", "user": "root", "port": 22, "keyPath": "~/.ssh/id_ed25519" },
  "paths": { "vcwd": "/root", "osRelease": "6.5.0-14-generic" },
  "env": {},
  "keepalive": 5000,
  "readyTimeout": 15000
}
```

Optional: `paths.socksProxy` (`"host:port"` — e.g. a wstunnel QUIC tunnel), `paths.home`
(force a HOME, skip the probe), `paths.cachePath` (directory for the per-connection cache).

## Logging

Structured logger with levels `error` / `warn` / `info` (default) / `debug` / `trace`.

- `LOG_LEVEL=trace` — every spawn routing decision + every SFTP protocol call.
- `LOG_LEVEL=debug` — adds the process-exit patch-survival check and SSH-ready timing.
- `LOG_FILE=path` — write JSON lines to a file instead of human-readable stderr.

The logger captures the original `fs` at module load, before any patching, so its output
never routes through the remote SFTP bridge.

## Data isolation

The agent keys its conversation history by working directory, so two remotes that both
expose `/root` would share one history. agent-shim prevents this with a **virtual workspace
prefix**: the agent sees its cwd as `/__box/<id>/<real-vcwd>`, where `<id>` is
`sha256(host:user:port)[:12]`. The agent's session-key hash (which does not normalize the
path) then buckets each connection distinctly, even when two remotes expose the same `/root`.

The prefix is stripped transparently before any `fs`/`child_process` op reaches the remote,
so the remote shell and SFTP see the real path. The agent's data root (`.qoder`, `~/.pi/agent`)
is **shared natively** — auth, LLM config, and settings are reused across connections, only
conversation history is isolated.

- **On by default.** No config needed; each `host:port:user` gets a distinct `/__box/<id>/`.
- `paths.isolateData: "profile"` — opt into the legacy per-profile data root (separate
  `QODER_CLI_HOME`/`PI_CODING_AGENT_DIR` per connection, isolating auth/LLM config too).
- `paths.dataDir` / `paths.cliHome` — directory / explicit path for the legacy profile dir.
- A user-set `QODER_CLI_HOME` (or `PI_CODING_AGENT_DIR`) env var always wins (highest priority).

## Adapters

agent-shim's core knows nothing about a specific agent. Agent-specific logic lives in an
adapter under `lib/adapters/`:

- **qoder** (`lib/adapters/qoder.js`) — recognizes qoder's entry files, intercepts its
  Linux-ELF runtime binary, sets its required env vars, declares prefetch/swallow-ENOENT
  paths, and isolates data via `QODER_CLI_HOME`.
- **pi** (`lib/adapters/pi.js`) — recognizes Pi's `dist/bundle/cli.js` entry and isolates
  data via `PI_CODING_AGENT_DIR`. Pi uses `cross-spawn` (which delegates to
  `child_process.spawn` on non-win32 — our `platform=linux` patch makes Pi take the
  native-spawn path, which we intercept). Pi's own config (`models.json`, `settings.json`)
  lives in its agent dir and is managed by the user — agent-shim does not seed or override it.
- **null** (`lib/adapters/null.js`) — passes everything through for non-agent programs.

To support a new agent, implement the adapter interface — see
[docs/adapter-api.md](docs/adapter-api.md).

## Tests

```bash
npm test                 # unit tests, no SSH required (mock SFTP)
npm run test:integration # end-to-end against a real remote (needs a config)
```

## License

MIT
