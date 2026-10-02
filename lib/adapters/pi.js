const path = require("path");
const os = require("os");
const { find } = require("../local-bash");

// Pi's entry is dist/bundle/cli.js (its npm "bin"). cli-runtime.js is the real runtime
// but argv[1] is the bin target (cli.js). Match the dist/bundle path to avoid false
// positives on a generic "cli.js" name.
function detectRole(mainScript) {
  const n = String(mainScript || "");
  if (n.endsWith("dist/bundle/cli.js") || n.endsWith("dist/bundle/cli-runtime.js")) return "agent";
  return "unknown";
}

function create(cfg) {
  function isHostInternalCmd(cmd) {
    // Pi has no host-internal snapshot/security scripts like qoder. Its host-side
    // helpers (native platform probe, WASM load) go through fs, not bash -c.
    return false;
  }

  function interceptSpawn(exe, args, opts) {
    // Pi has no ELF/native binary spawn that Windows can't run (unlike qoder's
    // runtime-info-linux). Its native clipboard helper is a .node addon loaded via
    // require(), not spawn(), and only when DISPLAY is set (skipped on the headless
    // Windows host). No interception needed.
    return null;
  }

  function getDefaultEnv() {
    // Pi sets its own identity env (PI_CODING_AGENT, AI_AGENT) in cli-runtime.js.
    // Unlike qoder, it has no auto-update gate to disable (update --self is manual).
    // No structural bridge env required.
    return {};
  }

  function getLocalBash() {
    if (cfg.localBash) return cfg.localBash;
    const home = os.homedir();
    // Pi doesn't ship a bundled git bash. Probe the common qoder location (if qoder is
    // also installed) then fall back to PATH scan (local-bash.find skips WSL's bash).
    return find([
      path.join(home, ".qoder", "bin", "git", "usr", "bin", "bash.exe"),
      path.join(home, ".qoder", "bin", "git", "bin", "bash.exe"),
    ]);
  }

  function getPrefetchPaths(cwd, parent) {
    const pp = (base, rel) => (base === "/" ? "/" + rel : base + "/" + rel);
    return {
      exists: [
        cwd + "/.pi/settings.json", cwd + "/.pi", cwd + "/.pi/extensions",
        cwd + "/.pi/skills", cwd + "/.pi/prompts", cwd + "/.pi/themes",
        cwd + "/.git", cwd + "/.gitignore", cwd + "/AGENTS.md",
        cwd + "/package.json", pp(parent, ".git"), pp(parent, "package.json"), cwd,
      ],
      stat: [cwd, cwd + "/.pi", cwd + "/.pi/settings.json", parent],
      read: [], readdir: [], access: [],
    };
  }

  function getSwallowEnoentPatterns() {
    // Pi creates session/worktree dirs lazily; readdir on a not-yet-existing dir during
    // worktree setup should return [] rather than throw, matching its expectations.
    return [/\/\.pi\/sessions\//];
  }

  function getProbeFiles() { return []; }
  function getProbeExists() { return []; }
  function needsOsReleaseFake() { return true; }
  function getExitCheckPath() { return null; }

  // Data isolation: Pi reads PI_CODING_AGENT_DIR (or PI_CODING_AGENT_SESSION_DIR) as the
  // agent data root (~/.pi/agent). Sessions live under <agentDir>/sessions/<cwd-slug>/,
  // keyed by cwd — same cross-remote /root collision as qoder. Setting PI_CODING_AGENT_DIR
  // to a per-profile dir isolates each connection. Pi's expandTildePath just normalizes,
  // so a plain absolute path works.
  function getDataDirEnv(profileDir) {
    if (!profileDir) return null;
    return { name: "PI_CODING_AGENT_DIR", value: profileDir };
  }

  return {
    name: "pi",
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
