const fs = require("fs");

if (!global.__REMOTE_LAUNCHED__ && process.platform === "win32") {
  global.__REMOTE_LAUNCHED__ = true;

  const logger = require("./logger").child("launcher");

  // Unlock the "bypassPermissions" (yolo) permission mode in remote-control. qoder's BQA() only
  // includes "bypassPermissions" when QODER_RUNNING_ENV==="cloud" (single consumer, no side
  // effects). Set BEFORE the remote-control bail: RC workers inherit process.env, and they skip
  // platform.apply (where getDefaultEnv normally sets this), so without this the RC worker never
  // gets the env. Lowest priority — a real shell env (QODER_RUNNING_ENV already set) wins.
  if (process.env.QODER_RUNNING_ENV === undefined) {
    process.env.QODER_RUNNING_ENV = "cloud";
  }

  // Non-invasive BYOK: register an ESM load hook that patches qodercli.js in memory (no file
  // edit). Enable via AGENT_SHIM_BYOK=1 env OR the config `byok: true` flag (persistent — set
  // once in .agent-shim.json, no per-launch env var needed). Env wins: =1 forces on, =0 forces
  // off; unset falls back to the config flag. Resolved BEFORE the remote-control bail because RC
  // workers (argv: qodercli.js --remote-control <sid>) inherit NODE_OPTIONS + process.env, load
  // this shim, and need the patch; they bail below, but the hook is already installed so their
  // qodercli.js load is patched. loadByokFlag() is a lightweight file read (no host/user/vcwd
  // requirement) so it works in the RC path where full config load() hasn't run yet. Setting
  // process.env here (rather than just a local var) propagates to RC worker subprocesses via
  // their env:{...process.env,...} spawn. Main thread only — worker_threads re-enter this file
  // but don't load the qodercli.js entry, and re-registering would warn.
  if (process.env.AGENT_SHIM_BYOK === undefined) {
    try { if (require("./config").loadByokFlag()) process.env.AGENT_SHIM_BYOK = "1"; } catch (_) {}
  }
  if (process.env.AGENT_SHIM_BYOK === "1") {
    let _isMain = true;
    try { _isMain = require("worker_threads").isMainThread; } catch (_) {}
    if (_isMain) {
      try {
        const { register } = require("module");
        const { pathToFileURL } = require("url");
        const hookUrl = pathToFileURL(require("path").join(__dirname, "byok-hook.mjs")).href;
        const bundlePath = require("path").join(require("os").homedir(), "AppData/Roaming/npm/node_modules/@qoder-ai/qodercli/bundle/qodercli.js");
        if (fs.existsSync(bundlePath)) {
          register(hookUrl, { data: { bundleUrl: pathToFileURL(bundlePath).href } });
          logger.info("BYOK ESM hook registered (non-invasive)");
        } else {
          logger.warn("BYOK hook: qodercli.js not found at " + bundlePath);
        }
      } catch (e) {
        logger.warn("BYOK ESM hook registration failed: " + (e && e.message));
      }
    }
  }

  const mainScript = String(process.argv[1] || "").replace(/\\/g, "/");

  // qoder remote-control is a local phone-pairing feature (sc.exe + QR on Windows) —
  // orthogonal to the SSH remote machine. Faking platform=linux makes qoder take the Linux
  // remote-control path, which fsyncs a local temp file and EPERMs on Windows. Bail before
  // any patching so qoder runs its native Windows path.
  if (process.argv.includes("remote-control")) {
    logger.info("remote-control subcommand: shim bypassed (local feature)");
    return;
  }

  require("./path-bridge");

  const { tryLoad } = require("./config");
  const cfg = tryLoad();

  const { select } = require("./adapters");
  const { role, adapter } = select(mainScript, cfg || { localBash: "", disableTelemetry: true });
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

  // Local mode: no remote config file and no connection env vars. BYOK patches are
  // already active (ESM hook registered above). Block telemetry, then let qoder run
  // natively on Windows — no platform faking, no fs/exec bridge, no transport.
  if (!cfg) {
    if (adapter && adapter.getTelemetryBlockPaths) {
      const paths = adapter.getTelemetryBlockPaths();
      if (paths && paths.length) {
        require("./core/net-block").install(paths);
        logger.info("local mode: telemetry blocked (paths: " + paths.join(", ") + ")");
      }
    }
    logger.info("local mode: no remote config — BYOK + telemetry patches active, running natively");
    return;
  }

  // Resolve remote HOME + os.release() BEFORE platform.apply: the platform layer needs
  // them, and they require an SFTP round-trip. Reads the on-disk probe cache first (fast,
  // no SSH wait); only on a cache miss does it block on sftpExec (~once, then cached).
  // cfg.home / cfg.osRelease explicit overrides skip the probe entirely.
  function resolveProbes(sftp, cfg, adapter) {
    const probes = {};

    function mapArch(m) {
      const s = String(m).trim();
      if (/^x86_64$|^amd64$/i.test(s)) return "x64";
      if (/^aarch64$|^arm64$/i.test(s)) return "arm64";
      if (/^armv[0-9].*|^arm$/i.test(s)) return "arm";
      if (/^i[3-6]86$|^x86$/i.test(s)) return "ia32";
      if (/^ppc64/i.test(s)) return "ppc64";
      if (/^s390x$/i.test(s)) return "s390x";
      return null;
    }

    // Determine which probes need a live exec (not satisfied by config).
    const needsReleaseFake = !cfg.osRelease && adapter && adapter.needsOsReleaseFake && adapter.needsOsReleaseFake();
    const needHome = !cfg.home;
    const needUnameR = needsReleaseFake;
    const needNodeV = !(cfg.nodeVersion && /^v?\d+\.\d+\.\d+/.test(cfg.nodeVersion));
    const needUnameM = !(cfg.arch && /^[a-z0-9]+$/i.test(cfg.arch));

    // Batch all needed probes into a single exec call (tag\tvalue per line).
    const cmds = [];
    if (needHome)    cmds.push('printf "H\\t%s\\n" "$HOME"');
    if (needUnameR)  cmds.push('printf "R\\t%s\\n" "$(uname -r 2>/dev/null)"');
    if (needNodeV)   cmds.push('printf "N\\t%s\\n" "$(node --version 2>/dev/null)"');
    if (needUnameM)  cmds.push('printf "M\\t%s\\n" "$(uname -m 2>/dev/null)"');

    const batch = {};
    if (cmds.length > 0) {
      try {
        const r = sftp.sftpExec(cmds.join("; "));
        for (const line of r.stdout.toString("utf8").split("\n")) {
          const m = line.split("\t");
          if (m.length === 2) batch[m[0]] = m[1];
        }
      } catch (e) {
        if (needHome) {
          throw new Error(
            "[agent-shim] remote HOME probe failed: " + e.message +
              ". Set paths.home in config as a fallback."
          );
        }
        logger.warn("batched probe exec failed: " + e.message);
      }
    }

    // HOME — config > batched exec (hard requirement).
    if (cfg.home) {
      probes.home = cfg.home;
    } else if (batch.H != null) {
      if (!batch.H) throw new Error("[agent-shim] remote HOME probe returned empty. Set paths.home in config as a fallback.");
      probes.home = batch.H;
    }

    // os.release() — config > batched exec (optional).
    if (needsReleaseFake && batch.R) {
      probes.osRelease = batch.R;
    }

    // Node version — batched exec > config override (optional).
    if (batch.N && /^v\d+\.\d+\.\d+/.test(batch.N)) {
      probes.nodeVersion = batch.N;
    }
    if (cfg.nodeVersion && /^v?\d+\.\d+\.\d+/.test(cfg.nodeVersion)) {
      probes.nodeVersion = cfg.nodeVersion.startsWith("v") ? cfg.nodeVersion : "v" + cfg.nodeVersion;
    }

    // Arch — batched exec > config override (optional).
    if (batch.M != null) {
      const a = mapArch(batch.M);
      if (a) probes.arch = a;
    }
    if (cfg.arch && /^[a-z0-9]+$/i.test(cfg.arch)) {
      probes.arch = cfg.arch;
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
    // Agent path.
    if (isAgentBundle) process.env.__REMOTE_AGENT_CHILD = "1";

    if (cfg.transport === "http") {
      // HTTP mode: remote-fs-node patches fs at the binding level, http-exec handles exec.
      // No fs-bridge needed — remote-fs-node IS the fs bridge.
      const debugCapture = require("./debug-capture");
      debugCapture.install();

      const { isRemote, toRemote } = require("./classifier");
      const httpExec = require("./http-exec");
      const exec = httpExec.create(cfg);
      global.__sftpExec = exec.sftpExec;
      global.__sftpExecAsync = exec.sftpExecAsync;

      const remoteFs = require("remote-fs-node");
      const baseURL = (cfg.tls ? "https://" : "http://") +
        (cfg.host.includes(":") ? "[" + cfg.host + "]" : cfg.host) + ":" + (cfg.port || 8765);
      remoteFs.configure({ baseURL, token: cfg.token, shouldRemote: isRemote, pathTransform: toRemote });
      remoteFs.patch({ patchSync: true, skipBinding: process.env.AGENT_SHIM_NO_BINDING === "1" });

      // Consumer-side cache: 60s TTL on existsSync/statSync/lstatSync,
      // realpath as string transform (no server call), cache invalidation on mutations.
      // Sits above remote-fs-node's binding-level patch, matching SSH mode's fs-bridge layer.
      const httpCache = require("./http-cache");
      httpCache.install(require("fs"), isRemote);

      if (debugCapture.enabled) {
        const patchedFs = require("fs");
        const nativePromises = Object.getOwnPropertyNames(Object.getPrototypeOf(debugCapture.realFs.promises)).filter(k => typeof debugCapture.realFs.promises[k] === "function");
        const remotePromises = Object.getOwnPropertyNames(Object.getPrototypeOf(patchedFs.promises)).filter(k => typeof patchedFs.promises[k] === "function");
        const missing = nativePromises.filter(k => !remotePromises.includes(k));
        debugCapture.log("fs.promises native methods: " + nativePromises.length + " remote: " + remotePromises.length + " missing: " + JSON.stringify(missing));
        debugCapture.log("binding patched: " + remoteFs.isBindingPatched());
        debugCapture.log("fs patched: " + remoteFs.isPatched());
      }

      const probes = resolveProbes(exec, cfg, adapter);
      const platform = require("./platform");
      const plat = platform.apply(cfg, adapter, probes);
      const execBridge = require("./exec-bridge");
      execBridge.apply(adapter, plat.getRemoteCwd);
      const pfN = httpCache.prefetchStartup(exec, cfg, adapter, plat.getRemoteCwd);
      if (pfN) logger.info("startup prefetch: " + pfN + " paths (batched exec)");
      const debug = require("./debug-hooks");
      debug.install(plat.getVcwd, adapter);

      if (cfg.disableTelemetry !== false && adapter && adapter.getTelemetryBlockPaths) {
        const paths = adapter.getTelemetryBlockPaths();
        if (paths && paths.length) {
          require("./core/net-block").install(paths);
          logger.info("telemetry blocked (paths: " + paths.join(", ") + ")");
        }
      }
      logger.info("ready (HTTP — remote-fs-node)");
    } else {
      // SSH mode: sftp-client → probe → platform → exec-bridge → fs-bridge → debug.
      const transportMod = require("./sftp-client");
      const transportLabel = "SFTP";
      const { create } = transportMod;
      let _t0 = Date.now();
      const sftp = create(cfg, (type, msg, extra) => {
        const dt = Date.now() - _t0;
        if (type === "ready") {
          logger.info(transportLabel + " ready", { ms: dt, workerMs: msg || "?" });
        }
        else if (type === "dead") logger.error(transportLabel + " DEAD (reconnects exhausted) — remote ops will fail");
        else if (type === "error") logger.warn(transportLabel + " error: " + msg);
        else if (type === "diag") logger.debug("transport: " + msg);
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
      const pfN = _fb.prefetchStartup();
      if (pfN) logger.info("startup prefetch: " + pfN + " paths (batched exec)");

      const debug = require("./debug-hooks");
      debug.install(plat.getVcwd, adapter);

      if (cfg.disableTelemetry !== false && adapter && adapter.getTelemetryBlockPaths) {
        const paths = adapter.getTelemetryBlockPaths();
        if (paths && paths.length) {
          require("./core/net-block").install(paths);
          logger.info("telemetry blocked (paths: " + paths.join(", ") + ")");
        }
      }
      logger.info("ready (" + transportLabel + " worker connecting)");
    }
  }
}
