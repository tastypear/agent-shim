const { Readable, Writable } = require("stream");
const { EventEmitter } = require("events");
const path = require("path");
const os = require("os");
const { find } = require("../local-bash");

function detectRole(mainScript) {
  if (mainScript.endsWith("qoder-npm-dispatcher.cjs")) return "dispatcher";
  if (/qodercli(-[\d.]+)?\.js$/.test(mainScript)) return "agent";
  return "unknown";
}

function create(cfg) {
  function isHostInternalCmd(cmd) {
    if (cmd.includes("eval '")) return false;
    return (
      cmd.includes("qodersec-launch") ||
      cmd.includes("shell-snapshots") ||
      cmd.startsWith("SNAPSHOT_FILE=") ||
      cmd.includes("__QODER_SNAPSHOT_PHASE") ||
      cmd.includes("ensure-deps")
    );
  }

  function interceptSpawn(exe, args, opts) {
    const exeStr = String(exe || "");
    if (!exeStr.includes("runtime-info-linux")) return null;
    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.stdin = new Writable({ write(c, e, d) { d(); } });
    child.pid = undefined;
    child.exitCode = 1;
    child.signalCode = null;
    child.unref = () => child;
    child.ref = () => child;
    child.kill = () => true;
    setTimeout(() => {
      child.stdout.push(Buffer.from("{\n"));
      child.stdout.push(null);
      child.stderr.push(Buffer.from("intercepted Linux ELF on Windows\n"));
      child.stderr.push(null);
      child.emit("close", 1, null);
    }, 50);
    return child;
  }

  function getDefaultEnv() {
    return {
      CLI_INTEGRATION_TEST: "true",
      QODER_TERMINAL_PTY_BACKEND: "in-process",
      // Unlock the "bypassPermissions" (yolo) option in remote-control's permission-mode list.
      // qoder's BQA() only pushes "bypassPermissions" when QODER_RUNNING_ENV==="cloud"; otherwise
      // the option is absent and greyed out in the web/mobile UI. "cloud" has exactly one consumer
      // in the bundle (BQA), so no side effects. Lowest priority — a real shell env wins (platform.js
      // three-layer merge only sets when process.env[k]===undefined).
      QODER_RUNNING_ENV: "cloud",
    };
  }

  function getLocalBash() {
    if (cfg.localBash) return cfg.localBash;
    const home = os.homedir();
    return find([
      path.join(home, ".qoder", "bin", "git", "usr", "bin", "bash.exe"),
      path.join(home, ".qoder", "bin", "git", "bin", "bash.exe"),
    ]);
  }

  function getPrefetchPaths(cwd, parent) {
    const pp = (base, rel) => (base === "/" ? "/" + rel : base + "/" + rel);
    return {
      exists: [
        cwd + "/.qoder/settings.json", cwd + "/.qoder/settings.local.json", cwd + "/.qoder/.env",
        cwd + "/.qoder/skills", cwd + "/.qoder/commands", cwd + "/.qoder",
        cwd + "/.git", cwd + "/.agents", cwd + "/.agents/skills",
        cwd + "/AGENTS.md", cwd + "/AGENTS.local.md",
        cwd + "/packages/qoder/package.json", pp(parent, "packages/qoder/package.json"),
        pp(parent, ".git"), cwd,
      ],
      stat: [
        cwd, cwd + "/.qoder", cwd + "/.qoder/settings.local.json",
        cwd + "/.qoder/settings.json", cwd + "/.qoder/skills", cwd + "/.qoder/commands",
        cwd + "/.qoder/.env", cwd + "/.git", cwd + "/.npmrc",
        cwd + "/packages/qoder/package.json", cwd + "/AGENTS.md", cwd + "/AGENTS.local.md",
        cwd + "/AGENTS.override.md",
        parent, "/.git", "/.npmrc", "/root", "/tmp",
        "/.dockerenv", "/run/.containerenv", "/proc/1/cgroup",
        "/packages/qoder/package.json",
        pp(parent, ".git"), pp(parent, "packages/qoder/package.json"),
      ],
      read: [
        "/proc/version", "/etc/machine-id", "/proc/1/cgroup", "/proc/self/cgroup",
        "/var/lib/dbus/machine-id",
        cwd + "/.qoder/settings.json", cwd + "/.qoderignore", cwd + "/.mcp.json",
        cwd + "/.qoder/scheduled_tasks.json", cwd + "/.npmrc",
        cwd + "/package.json", pp(parent, "package.json"), "/package.json",
        "/etc/npm/config", "/etc/npmrc",
        "/root/.config/npm/config", "/root/.config/npm",
        "/root/.npm/config", "/root/.npmrc",
      ],
      readdir: [
        cwd, cwd + "/.qoder", cwd + "/.qoder/agents", cwd + "/.qoder/output-styles",
        cwd + "/.qoder/rules", cwd + "/.qoder/workflows", "/",
      ],
      access: [
        cwd + "/.git", "/.git", cwd + "/AGENTS.md", cwd + "/AGENTS.local.md",
        "/bin/bash",
      ],
    };
  }

  function getSwallowEnoentPatterns() {
    return [/\/\.qoder\/worktrees\//];
  }

  function getProbeFiles() { return []; }
  function getProbeExists() { return []; }
  function needsOsReleaseFake() { return true; }
  function getExitCheckPath() { return null; }

  // Commands to prefetch at startup (batch exec, parallel). Results are cached
  // so individual execSync calls from qoder hit the cache instead of the server.
  function getPrefetchCommands() {
    return [
      "command -v agy", "command -v antigravity", "command -v cursor",
      "command -v emacs", "command -v hx", "command -v nvim",
      "command -v vim", "command -v code", "command -v codium",
      "command -v windsurf", "command -v zed", "command -v zeditor",
    ];
  }

  // OTLP (OpenTelemetry) collector paths qoder's telemetry exporter POSTs to. qoder
  // routes telemetry through http.request/https.request (the OTLP HTTP exporter), while
  // its own API — login, auth, userinfo, chat — goes through fetch/undici with /api/*
  // paths. So blocking these three OTLP paths at the http.request layer silences
  // telemetry without touching login/auth. Path-level (not host-level) on purpose:
  // api2.qoder.sh may in theory carry other traffic, and /v1/traces|logs|metrics are
  // OTEL-standard paths no qoder API ever uses.
  function getTelemetryBlockPaths() {
    return ["/v1/traces", "/v1/logs", "/v1/metrics"];
  }

  // Legacy per-profile data isolation (opt-in via isolateData="profile"). By default the
  // virtual workspace prefix (/◦<host∶port>/) isolates qoder's sessions by cwd-hash while
  // sharing .qoder (auth, LLM config, settings) natively — no QODER_CLI_HOME override. This
  // path is only used when a user explicitly opts into full per-connection .qoder separation.
  function getDataDirEnv(profileDir) {
    if (!profileDir) return null;
    return { name: "QODER_CLI_HOME", value: profileDir };
  }

  return {
    name: "qoder",
    isHostInternalCmd,
    interceptSpawn,
    getDefaultEnv,
    getLocalBash,
    getPrefetchPaths,
    getPrefetchCommands,
    getSwallowEnoentPatterns,
    getProbeFiles,
    getProbeExists,
    needsOsReleaseFake,
    getExitCheckPath,
    getDataDirEnv,
    getTelemetryBlockPaths,
  };
}

module.exports = { detectRole, create };
