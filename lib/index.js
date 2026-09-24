const path = require("path");
const os = require("os");
const fs = require("fs");

if (!global.__REMOTE_LAUNCHED__ && process.platform === "win32") {
  global.__REMOTE_LAUNCHED__ = true;

  const mainScript = String(process.argv[1] || "").replace(/\\/g, "/");

  require("./path-bridge");

  const { load } = require("./config");
  const cfg = load();

  const { select } = require("./adapters");
  const { role, adapter } = select(mainScript, cfg);
  const isDispatcher = role === "dispatcher";
  const isAgentBundle = role === "agent";

  let isWorkerThread = false;
  try {
    isWorkerThread = require("worker_threads").isMainThread === false;
  } catch (e) {}

  const isHelper = !isDispatcher && !isAgentBundle && (process.env.__REMOTE_AGENT_CHILD === "1" || isWorkerThread);
  const isChild = isHelper;

  if (isDispatcher) {
    delete process.env.__REMOTE_AGENT_CHILD;
    return;
  }

  if (isWorkerThread) return;

  const platform = require("./platform");
  const plat = platform.apply(cfg, adapter);

  const execBridge = require("./exec-bridge");
  execBridge.apply(adapter, plat.getRemoteCwd);

  if (!isChild && !isDispatcher) {
    if (isAgentBundle) process.env.__REMOTE_AGENT_CHILD = "1";

    const { create } = require("./sftp-client");
    const _t0 = Date.now();
    let _fsBridgeRefresh = null;
    const sftp = create(cfg, (type, msg, extra) => {
      const dt = Date.now() - _t0;
      if (type === "ready") {
        process.stderr.write("[launcher] SFTP ready (+" + dt + "ms, worker reported " + (msg||"?") + "ms)\n");
        if (_fsBridgeRefresh) _fsBridgeRefresh();
      }
      else if (type === "dead") process.stderr.write("[launcher] SFTP DEAD (reconnects exhausted) — remote ops will fail\n");
      else if (type === "error") process.stderr.write("[launcher] SFTP error: " + msg + "\n");
      else if (type === "workerError") process.stderr.write("[launcher] worker: " + msg + "\n");
    });

    global.__sftpExec = sftp.sftpExec;
    global.__sftpExecAsync = sftp.sftpExecAsync;

    const fsBridge = require("./fs-bridge");
    const _fb = fsBridge.apply(sftp, plat.getRemoteCwd, cfg, adapter);
    _fsBridgeRefresh = _fb.refreshProbesAsync;

    const debug = require("./debug-hooks");
    debug.install(sftp, plat.getVcwd, adapter);

    process.stderr.write("[launcher] ready (SFTP worker connecting)\n");
  } else {
    process.stderr.write = function () {
      return true;
    };
  }
}
