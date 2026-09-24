// lib/platform.js
// Patches process.platform, process.cwd, and env vars so the host Node process looks like
// a Linux environment to the agent code running inside it.
//
// KEEP platform=linux: this is what makes qoder's Cc() return "linux" (AI sees Linux in the
// system prompt → generates POSIX paths → bash commands work on remote). With win32, Cc()
// short-circuits to "windows" without reading /proc/version, so faking /proc/version alone
// can't make the AI see Linux — platform must be linux.

const os = require("os");

function apply(cfg, adapter) {
  Object.defineProperty(process, "platform", {
    value: "linux",
    writable: true,
    configurable: true,
    enumerable: true,
  });

  // Override os.release() so qoder's system prompt (`OS Version: ${os.release()}`) shows a
  // Linux-style value instead of the real Windows build number (e.g. "10.0.19044"). The
  // Windows value leaking into a platform=linux prompt is contradictory and makes the AI
  // try to verify the platform. Only override when an explicit value is configured — we
  // never query the remote for this.
  if (cfg.osRelease) {
    try {
      os.release = () => String(cfg.osRelease);
    } catch (e) {}
  }

  if (!process.env.SHELL) process.env.SHELL = "/bin/bash";
  if (!process.env.HOME) process.env.HOME = "/root";

  // Pin TMPDIR to the real Windows temp (drive-qualified). qoder's own tmpdir() impl reads
  // TMPDIR first and short-circuits; without this it falls back to accessSync("/tmp"), which
  // the drive-based classifier routes REMOTE (no drive + posix-absolute) — the remote /tmp
  // exists and is writable, so qoder wrongly adopts /tmp as its local session-temp base and
  // later mkdir("/tmp/qoder-cli-0/...") fails ENOENT on the remote. A drive-qualified TMPDIR
  // keeps qoder's runtime temp local under all classifiers. Respect an explicit override.
  if (!process.env.TMPDIR) {
    try {
      process.env.TMPDIR = os.tmpdir();
    } catch (e) {}
  }

  // ===== Env vars: three-layer priority (highest → lowest) =====
  //   1. Real process.env (user set it in their shell — always wins)
  //   2. config.env (user's .remote-bridge.json "env" section — explicit override)
  //   3. adapter.getDefaultEnv() (structural bridge requirements, e.g.
  //      CLI_INTEGRATION_TEST, QODER_TERMINAL_PTY_BACKEND — NOT user preferences)
  //
  // Adapter defaults are agent-specific (qoder needs them; a null adapter needs none),
  // so non-qoder programs aren't forced into qoder-specific settings.
  const adapterEnv = (adapter && adapter.getDefaultEnv) ? adapter.getDefaultEnv() : {};
  const mergedEnv = { ...(adapterEnv || {}), ...((cfg.extraEnv && typeof cfg.extraEnv === "object") ? cfg.extraEnv : {}) };
  for (const k of Object.keys(mergedEnv)) {
    if (process.env[k] === undefined) {
      process.env[k] = String(mergedEnv[k]);
    }
  }

  // ===== CWD =====
  // Virtual cwd: the agent sees a posix path (/root). path.resolve derives drives from
  // process.cwd(), which returns this drive-less value, so remote paths never pick up a
  // drive — keeping them classified remote.
  let vCwd = cfg.vcwd || "/root";
  process.cwd = () => vCwd;
  const _chdir = process.chdir;
  process.chdir = (d) => {
    const n = String(d).replace(/\\/g, "/");
    if (n.startsWith("/")) {
      vCwd = n;
      return;
    }
    try {
      _chdir.call(process, d);
    } catch (e) {}
  };

  // Expose vCwd getter/setter for other modules (exec-bridge needs getRemoteCwd).
  return {
    getVcwd: () => vCwd,
    setVcwd: (v) => {
      vCwd = v;
    },
    getRemoteCwd: () => {
      const c = vCwd.replace(/\\/g, "/");
      return c.startsWith("/") ? c : "/root";
    },
  };
}

module.exports = { apply };
