# agent-shim

A launcher that makes Node.js-based AI agents seamlessly manage remote hosts. 

The program injects a remote Linux environment into an AI Agent running on Windows via the Node `--require` flag.

It draws inspiration from "VS Code Remote-SSH + Copilot" but imposes **no performance requirements** on the remote host.

## Apps adapted
- [qodercli](https://www.npmjs.com/package/@qoder-ai/qodercli)
- Pi (Verification and testing only)

## Getting started

### Requirements

SSH mode (default): no extra packages needed.

HTTP mode: install the client libraries.
```
npm i remote-fs-node
npm i remote-cp-node
```

### Launch

```ps1
$env:AGENT_SHIM_CONFIG="C:/agent-shim.json"
$env:NODE_OPTIONS="--require C:/path/of/agent-shim/lib/index.js"
qoder
```

* agent-shim reads a JSON config file (see [`.agent-shim.example.json`](.agent-shim.example.json)).

### Example

```json
{
  "transport": "ssh",
  "ssh": { "host": "my-host", "user": "root", "port": 22, "keyPath": "~/.ssh/id_ed25519" },
  "paths": { "vcwd": "/root" },
  "keepalive": 5000,
  "readyTimeout": 15000
}
```

## Transport modes

| Mode | Config | Description |
|---|---|---|
| **SSH** | `"transport": "ssh"` | SFTP + exec over a single ssh2 connection.|
| **HTTP** | `"transport": "http"` | Routes fs and exec through a [remote-ops-server](https://github.com/tastypear/remote-ops-server) instance.|

## Some useful environment variables

| Variable | Purpose |
|---|---|
| `AGENT_SHIM_CONFIG` | Path to config file |
| `REMOTE_BRIDGE_SOCKS_PROXY` | SOCKS5 proxy (`host:port`) |
| `AGENT_SHIM_DEBUG` | Enable general debug capture (uncaught exceptions, stderr monitoring) |
| `AGENT_SHIM_DEBUG_HTTP` | Capture all HTTP wire-level events and exec-cache lookups to a file (`1` = default path, or a custom path) |
| `AGENT_SHIM_CACHE_DEBUG` | Enable cache prefetch debug logging |
| `LOG_LEVEL` | Logger level: `error` / `warn` / `info` (default) / `debug` / `trace` |
| `LOG_FILE` | Write logs to a file instead of stderr |

## Adapters

agent-shim's core is agent-agnostic. Agent-specific logic lives in adapters under
`lib/adapters/`:

- **qoder** — recognizes qoder's entry files, intercepts its Linux binary, declares
  prefetch paths and commands, isolates data.
- **pi** — recognizes [Pi](https://github.com/earendil-works/pi)'s entry, isolates data.
- **null** — pass-through for non-agent programs.

To support a new agent, implement the adapter interface — see
[docs/adapter-api.md](docs/adapter-api.md).

## License

MIT