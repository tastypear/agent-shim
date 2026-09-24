const { Readable, Writable } = require("stream");
const { EventEmitter } = require("events");
const path = require("path");
const os = require("os");
const { find } = require("../local-bash");

function detectRole(mainScript) {
  if (mainScript.endsWith("qoder-npm-dispatcher.cjs")) return "dispatcher";
  if (mainScript.endsWith("qodercli.js")) return "agent";
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
      stat: [cwd, cwd + "/.qoder", cwd + "/.qoder/settings.local.json", parent],
    };
  }

  function getSwallowEnoentPatterns() {
    return [/\/\.qoder\/worktrees\//];
  }

  function getProbeFiles() { return []; }
  function getProbeExists() { return []; }
  function needsOsReleaseFake() { return true; }
  function getExitCheckPath() { return null; }

  // Data isolation: qoder reads QODER_CLI_HOME (or GEMINI_CLI_HOME) as the root for ALL
  // its data — sessions, auth, logs, cache, plugins. Setting it to a per-profile dir
  // isolates conversations by connection+vcwd, fixing the cross-remote /root collision.
  // The value is the profile dir itself; qoder creates .qoder under it.
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
    getSwallowEnoentPatterns,
    getProbeFiles,
    getProbeExists,
    needsOsReleaseFake,
    getExitCheckPath,
    getDataDirEnv,
  };
}

module.exports = { detectRole, create };
