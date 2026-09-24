// lib/adapter.js
// HostRuntimeAdapter interface + qoder implementation.
//
// The adapter is the ONLY module that knows about a specific agent (qoder). Core modules
// (fs-bridge, exec-bridge) call adapter methods to decide host-internal vs. remote routing.
// To support a different agent, implement this interface and pass it to the launcher entry.

/**
 * @typedef {Object} HostRuntimeAdapter
 * @property {string} name                    - adapter identifier ("qoder", etc.)
 * @property {(cmd: string) => boolean} isHostInternalCmd
 *   Given a bash -c command string, return true if it's a host-internal helper that must
 *   run locally (e.g. qoder's snapshot/ensure-deps/security-resources). These reference
 *   Windows paths and cannot run on the remote.
 * @property {(exe: string) => boolean} [shouldInterceptRuntimeBinary]
 *   Given a binary name (e.g. "node", "npm"), return true if it should be intercepted
 *   (routed remote / handled specially) rather than passed through to native spawn.
 *   Default: false (pass through).
 * @property {(exe: string, args: any[], opts: any) => any} [interceptSpawn]
 *   Optional spawn interceptor for agent-specific binary handling (e.g. qoder's
 *   runtime-info-linux-x64 ELF binary that can't run on Windows).
 *   Return a synthetic child object, or null to let normal routing proceed.
 * @property {() => Object<string,string>} [getDefaultEnv]
 *   Return env vars the adapter requires by structural necessity (not user config).
 *   These are the lowest-priority layer: real process.env > config env > adapter
 *   defaults. e.g. qoder needs CLI_INTEGRATION_TEST (auto-update can't work through
 *   the bridge) and QODER_TERMINAL_PTY_BACKEND=in-process (no real PTY under bridge).
 * @property {() => string} [getLocalBash]
 *   Return the path to a local bash.exe for host-internal commands, or "" if none.
 */

// ===== Qoder adapter =====
function createQoderAdapter(cfg) {
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

  function shouldInterceptRuntimeBinary(exe) {
    // platform=linux makes qoder's umid module select runtime-info-linux-x64 (an ELF binary)
    // and spawn it on Windows. Windows cannot execute ELF → hang. Intercept it.
    const exeStr = String(exe || "");
    return exeStr.includes("runtime-info-linux");
  }

  // The interceptSpawn for runtime-info-linux is handled in exec-bridge via a dedicated
  // check, because it needs to construct a synthetic child with streams. The adapter only
  // signals that interception is needed.

  function getLocalBash() {
    return cfg.localBash || "";
  }

  // Env vars the bridge structurally requires for qoder — not user preferences.
  // CLI_INTEGRATION_TEST: qoder's pI() gate skips both the update-notification HTTP
  //   check AND the `npm install -g @qoder-ai/qodercli@latest` self-install. Under the
  //   bridge the self-install either runs against the wrong npm (local Windows) or
  //   fails on a remote with no npm — either way it must not fire. This env is qoder's
  //   own "I'm in a test harness, don't auto-update" signal, semantically exact.
  // QODER_TERMINAL_PTY_BACKEND=in-process: the bridge provides no real PTY; qoder's
  //   terminal must stay in-process.
  function getDefaultEnv() {
    return {
      CLI_INTEGRATION_TEST: "true",
      QODER_TERMINAL_PTY_BACKEND: "in-process",
    };
  }

  return {
    name: "qoder",
    isHostInternalCmd,
    shouldInterceptRuntimeBinary,
    getLocalBash,
    getDefaultEnv,
  };
}

// Minimal no-op adapter for non-qoder programs. Everything passes through to native spawn;
// no host-internal command recognition. This is the starting point for new adapters.
function createNullAdapter(cfg) {
  return {
    name: "none",
    isHostInternalCmd: () => false,
    shouldInterceptRuntimeBinary: () => false,
    getLocalBash: () => cfg.localBash || "",
    getDefaultEnv: () => ({}),
  };
}

module.exports = { createQoderAdapter, createNullAdapter };
