const fs = require("fs");

if (!global.__REMOTE_LAUNCHED__ && process.platform === "win32") {
  global.__REMOTE_LAUNCHED__ = true;

  const logger = require("./logger").child("launcher");

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

  // Resolve remote HOME + os.release() BEFORE platform.apply: the platform layer needs
  // them, and they require an SFTP round-trip. Reads the on-disk probe cache first (fast,
  // no SSH wait); only on a cache miss does it block on sftpExec (~once, then cached).
  // cfg.home / cfg.osRelease explicit overrides skip the probe entirely.
  function resolveProbes(sftp, cfg, adapter) {
    const probes = {};
    let cached = null;
    try {
      if (cfg && cfg.cacheFile) cached = JSON.parse(fs.readFileSync(cfg.cacheFile, "utf8"));
    } catch (e) { cached = null; }

    if (cfg.home) {
      probes.home = cfg.home;
    } else if (cached && cached.home) {
      probes.home = cached.home;
    } else {
      try {
        const home = sftp.sftpExec("echo $HOME").stdout.toString("utf8").trim();
        if (!home) throw new Error("empty result");
        probes.home = home;
      } catch (e) {
        throw new Error(
          "[agent-shim] remote HOME probe failed: " + e.message +
            ". Set paths.home in config as a fallback."
        );
      }
    }

    if (!cfg.osRelease && adapter && adapter.needsOsReleaseFake && adapter.needsOsReleaseFake()) {
      if (cached && cached.uname) {
        probes.osRelease = cached.uname;
      } else {
        try {
          const v = sftp.sftpExec("uname -r").stdout.toString("utf8").trim();
          if (v) probes.osRelease = v;
        } catch (e) {
          logger.warn("uname -r probe failed: " + e.message + " — os.release() left untouched");
        }
      }
    }
    return probes;
  }

  if (isChild) {
    // Helper subprocess: platform + exec patches only. No SFTP — HOME/platform were
    // inherited from the agent process env. Suppress stderr (helper JSON protocol).
    const platform = require("./platform");
    const plat = platform.apply(cfg, adapter, null);
    const execBridge = require("./exec-bridge");
    execBridge.apply(adapter, plat.getRemoteCwd);
    process.stderr.write = function () { return true; };
  } else {
    // Agent path: SFTP → probe → platform → exec-bridge → fs-bridge → debug.
    if (isAgentBundle) process.env.__REMOTE_AGENT_CHILD = "1";

    const { create } = require("./sftp-client");
    const _t0 = Date.now();
    let _fsBridgeRefresh = null;
    const sftp = create(cfg, (type, msg, extra) => {
      const dt = Date.now() - _t0;
      if (type === "ready") {
        logger.info("SFTP ready", { ms: dt, workerMs: msg || "?" });
        if (_fsBridgeRefresh) _fsBridgeRefresh();
      }
      else if (type === "dead") logger.error("SFTP DEAD (reconnects exhausted) — remote ops will fail");
      else if (type === "error") logger.warn("SFTP error: " + msg);
      else if (type === "diag") logger.debug("ssh: " + msg);
      else if (type === "workerError") logger.warn("worker: " + msg);
    });

    global.__sftpExec = sftp.sftpExec;
    global.__sftpExecAsync = sftp.sftpExecAsync;

    const probes = resolveProbes(sftp, cfg, adapter);

    const platform = require("./platform");
    const plat = platform.apply(cfg, adapter, probes);

    const execBridge = require("./exec-bridge");
    execBridge.apply(adapter, plat.getRemoteCwd);

    const fsBridge = require("./fs-bridge");
    const _fb = fsBridge.apply(sftp, plat.getRemoteCwd, cfg, adapter, probes);
    _fsBridgeRefresh = _fb.refreshProbesAsync;

    const debug = require("./debug-hooks");
    debug.install(plat.getVcwd, adapter);

    logger.info("ready (SFTP worker connecting)");
  }
}
