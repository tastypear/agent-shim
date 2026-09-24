// lib/index.js
// Entry point for the modular remote launcher. Used via:
//   node --require /path/to/qoder-remote-launcher/lib/index.js <agent>
//
// Role detection determines which context this preload is running in:
//   (1) qoder-npm-dispatcher.cjs — thin wrapper that spawnSyncs qodercli.js.
//       Must NOT patch (findIde needs platform=win32). Hands child a clean env.
//   (2) qodercli.js — the real agent. Patches fully + builds SFTP worker.
//   (3) helper subprocess — __REMOTE_AGENT_CHILD=1. Skip patches, suppress stderr.
//   (4) worker_threads — skip entirely (recursion/storm prevention).

const path = require("path");
const os = require("os");
const fs = require("fs");

if (!global.__REMOTE_LAUNCHED__ && process.platform === "win32") {
  global.__REMOTE_LAUNCHED__ = true;

  const mainScript = String(process.argv[1] || "").replace(/\\/g, "/");
  const isDispatcher = mainScript.endsWith("qoder-npm-dispatcher.cjs");
  const isAgentBundle = mainScript.endsWith("qodercli.js");

  let isWorkerThread = false;
  try {
    isWorkerThread = require("worker_threads").isMainThread === false;
  } catch (e) {}

  const isHelper = !isDispatcher && !isAgentBundle && (process.env.__REMOTE_AGENT_CHILD === "1" || isWorkerThread);
  const isChild = isHelper;

  if (isDispatcher) {
    // Hand the qodercli.js child a clean env so it patches fully as the agent.
    delete process.env.__REMOTE_AGENT_CHILD;
    return;
  }

  if (isWorkerThread) return;

  // ===== Patch path module (before anything uses it) =====
  // Must run before config/platform — remote paths use posix semantics, local uses win32.
  require("./path-bridge");

  // ===== Load config =====
  const { load } = require("./config");
  const cfg = load();

  // ===== Create adapter (before platform — platform merges adapter env defaults) =====
  const { createQoderAdapter, createNullAdapter } = require("./adapter");
  const adapter = isAgentBundle ? createQoderAdapter(cfg) : createNullAdapter(cfg);

  // ===== Apply platform patches =====
  const platform = require("./platform");
  const plat = platform.apply(cfg, adapter);

  // ===== Apply exec bridge (spawn/exec routing) =====
  const execBridge = require("./exec-bridge");
  execBridge.apply(adapter, plat.getRemoteCwd);

  // ===== SFTP bridge + fs patches (agent process only) =====
  if (!isChild && !isDispatcher) {
    if (isAgentBundle) process.env.__REMOTE_AGENT_CHILD = "1";

    const { create } = require("./sftp-client");
    const _t0 = Date.now();
    let _fsBridgeRefresh = null;
    const sftp = create(cfg, (type, msg, extra) => {
      const dt = Date.now() - _t0;
      if (type === "ready") {
        process.stderr.write("[launcher] SFTP ready (+" + dt + "ms, worker reported " + (msg||"?") + "ms)\n");
        // Background: refresh environment probe cache for next launch (non-blocking).
        if (_fsBridgeRefresh) _fsBridgeRefresh();
      }
      else if (type === "dead") process.stderr.write("[launcher] SFTP DEAD (reconnects exhausted) — remote ops will fail\n");
      else if (type === "error") process.stderr.write("[launcher] SFTP error: " + msg + "\n");
      else if (type === "workerError") process.stderr.write("[launcher] worker: " + msg + "\n");
    });

    // Expose sftpExec globally for exec-bridge's makeSftpExecChild.
    // __sftpExec = sync (blocks main thread via Atomics.wait) — used by spawnSync/
    //   execFileSync and fs sync ops, which cannot be async.
    // __sftpExecAsync = non-blocking Promise — used by cp.spawn / cp.execFile hot path
    //   so parallel Agent subagents and parallel rg invocations don't serialize.
    global.__sftpExec = sftp.sftpExec;
    global.__sftpExecAsync = sftp.sftpExecAsync;

    // Apply fs patches.
    const fsBridge = require("./fs-bridge");
    const _fb = fsBridge.apply(sftp, plat.getRemoteCwd, cfg);
    _fsBridgeRefresh = _fb.refreshProbesAsync;

    // Install debug hooks if enabled.
    const debug = require("./debug-hooks");
    debug.install(sftp, plat.getVcwd);

    process.stderr.write("[launcher] ready (SFTP worker connecting)\n");
  } else {
    // Child/helper process: suppress stderr to avoid interfering with helper JSON protocol.
    process.stderr.write = function () {
      return true;
    };
  }
}
