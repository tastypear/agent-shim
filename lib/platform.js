// lib/platform.js
// Patches process.platform, process.cwd, and env vars so the host Node process looks like
// a Linux environment to the agent code running inside it.
//
// KEEP platform=linux: this is what makes qoder's Cc() return "linux" (AI sees Linux in the
// system prompt → generates POSIX paths → bash commands work on remote). With win32, Cc()
// short-circuits to "windows" without reading /proc/version, so faking /proc/version alone
// can't make the AI see Linux — platform must be linux.
//
// HOME and os.release() come from remote probes (see index.js resolveProbes): read from the
// on-disk probe cache for a fast startup, or fetched live over SFTP on first run. An explicit
// config value (cfg.osRelease) or a user-set env var (HOME) always wins and skips the probe.

const os = require("os");
const fs = require("fs");
const { hasWorkspacePrefix, makeVirtualCwd, toRemote } = require("./classifier");

function apply(cfg, adapter, probes) {
  Object.defineProperty(process, "platform", {
    value: "linux",
    writable: true,
    configurable: true,
    enumerable: true,
  });

  // Override os.release() so qoder's system prompt (`OS Version: ${os.release()}`) shows a
  // Linux-style value instead of the real Windows build number (e.g. "10.0.19044"). The
  // Windows value leaking into a platform=linux prompt is contradictory and makes the AI
  // try to verify the platform. Priority: cfg.osRelease > probed `uname -r` (only when the
  // adapter declares it needs the fake) > leave the real value untouched.
  const needsReleaseFake = adapter && adapter.needsOsReleaseFake ? adapter.needsOsReleaseFake() : false;
  const releaseVal = cfg.osRelease || ((needsReleaseFake && probes && probes.osRelease) ? probes.osRelease : "");
  if (releaseVal) {
    try { os.release = () => String(releaseVal); } catch (e) {}
  }

  if (!process.env.SHELL) process.env.SHELL = "/bin/bash";

  // HOME: the probed remote HOME (or cfg.home, folded into probes by resolveProbes)
  // overrides the ambient Windows process.env.HOME. The Windows value is a
  // drive-qualified local path that would misroute ~-relative paths to the local
  // filesystem. resolveProbes guarantees probes.home — it throws on an empty probe.
  if (probes && probes.home) {
    process.env.HOME = probes.home;
  } else if (!process.env.HOME) {
    throw new Error(
      "[agent-shim] No HOME available: set paths.home in config, or ensure the remote HOME probe can run."
    );
  }

  // Node version: the system-prompt Env block renders `Node.js version: ${process.version}`.
  // The host's Windows Node version (e.g. v24.18.0) leaks through; the LLM then runs
  // `node --version` on the remote, sees a different value, and hypothesizes nvm. Override
  // with the probed remote version (e.g. v20.19.2). Safe because every graceful-fs feature
  // check in the bundle tests for ancient versions (v0.5–v1.8); any modern version passes
  // them identically. Also patch process.versions.node (some code reads that form).
  if (probes && probes.nodeVersion) {
    try {
      Object.defineProperty(process, "version", {
        value: probes.nodeVersion,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch (e) {}
    try {
      const bare = probes.nodeVersion.replace(/^v/, "");
      const orig = process.versions || {};
      Object.defineProperty(process, "versions", {
        value: { ...orig, node: bare },
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch (e) {}
  }

  // Pin TMPDIR to the real Windows temp (drive-qualified). qoder's own tmpdir() impl reads
  // TMPDIR first and short-circuits; without this it falls back to accessSync("/tmp"), which
  // the drive-based classifier routes REMOTE — the remote /tmp exists and is writable, so
  // qoder wrongly adopts /tmp as its local session-temp base and later mkdir("/tmp/...")
  // fails ENOENT on the remote. A drive-qualified TMPDIR keeps qoder's runtime temp local
  // under all classifiers. Respect an explicit override.
  if (!process.env.TMPDIR) {
    try {
      process.env.TMPDIR = os.tmpdir();
    } catch (e) {}
  }

  // ===== Env vars: three-layer priority (highest → lowest) =====
  //   1. Real process.env (user set it in their shell — always wins)
  //   2. config.env (user's .agent-shim.json "env" section — explicit override)
  //   3. adapter.getDefaultEnv() (structural bridge requirements, e.g.
  //      CLI_INTEGRATION_TEST, QODER_TERMINAL_PTY_BACKEND — NOT user preferences)
  const adapterEnv = (adapter && adapter.getDefaultEnv) ? adapter.getDefaultEnv() : {};
  const mergedEnv = { ...(adapterEnv || {}), ...((cfg.extraEnv && typeof cfg.extraEnv === "object") ? cfg.extraEnv : {}) };
  for (const k of Object.keys(mergedEnv)) {
    if (process.env[k] === undefined) {
      process.env[k] = String(mergedEnv[k]);
    }
  }

  // ===== Data isolation =====
  // Default: the virtual workspace prefix (applied below in the CWD section) isolates qoder's
  // sessions by cwd-hash, so .qoder (auth, LLM config, settings) is shared natively — no
  // QODER_CLI_HOME override. Legacy per-profile isolation is an opt-in escape hatch
  // (isolateData="profile") for users who want each connection's entire .qoder separated.
  if (cfg.isolateData === true && adapter && adapter.getDataDirEnv) {
    const cliHome = cfg.cliHomeExplicit || cfg.profileDir;
    const env = adapter.getDataDirEnv(cliHome);
    if (env && process.env[env.name] === undefined) {
      try {
        fs.mkdirSync(String(env.value), { recursive: true });
      } catch (e) {}
      process.env[env.name] = String(env.value);
    }
  }

  // ===== CWD =====
  // Virtual cwd: the agent sees a posix path. path.resolve derives drives from
  // process.cwd(), which returns this drive-less value, so remote paths never pick up a
  // drive — keeping them classified remote. cfg.vcwd is required (config.js enforces it).
  //
  // By default the cwd is wrapped in a /◦<boxId>/ prefix (boxId = "host∶port") so qoder's
  // session-key hash (CB, non-normalizing) buckets each connection distinctly even when two
  // remotes expose the same vcwd. The prefix is stripped by classifier.toRemote before any
  // fs/exec op reaches the remote, so the remote shell and SFTP see the real path.
  // getRemoteCwd() returns the stripped (real) path for `cd` commands sent to the remote shell.
  let vCwd = cfg.vcwd;
  if (cfg.isolateData !== true && cfg.boxId && !hasWorkspacePrefix(cfg.vcwd)) {
    vCwd = makeVirtualCwd(cfg.boxId, cfg.vcwd);
  }
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
    // The remote shell has no /◦<host∶port> dir, so strip the virtual prefix before handing the cwd
    // to exec-bridge's `cd '<rc>'` wrapper. Falls back to throwing if somehow non-posix.
    getRemoteCwd: () => {
      const c = vCwd.replace(/\\/g, "/");
      if (!c.startsWith("/")) {
        throw new Error("[agent-shim] virtual cwd is not a posix-absolute path: " + JSON.stringify(c));
      }
      return toRemote(c);
    },
  };
}

module.exports = { apply };
