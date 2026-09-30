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

    // Probe the remote Node version so the system-prompt Env block
    // (`Node.js version: ${process.version}`) reports what the remote actually runs,
    // not the host's Windows Node. Without this the LLM sees a mismatch with the
    // remote `node --version`, then wrongly hypothesizes nvm. Safe to override
    // process.version: every graceful-fs feature-detection check in the bundle tests
    // for ancient versions (v0.5–v1.8); any modern version (host v24, remote v18+)
    // passes them identically. `node --version` prints "v20.19.2" (with the v); keep
    // that format since process.version is "v<major>.<minor>.<patch>". A missing remote
    // node yields empty stdout → we leave the host version untouched rather than blank.
    if (cached && cached.nodeVersion) {
      probes.nodeVersion = cached.nodeVersion;
    } else {
      try {
        const v = sftp.sftpExec("node --version").stdout.toString("utf8").trim();
        if (/^v\d+\.\d+\.\d+/.test(v)) probes.nodeVersion = v;
      } catch (e) {
        logger.warn("node --version probe failed: " + e.message + " — process.version left untouched");
      }
    }
    // Explicit config override always wins and skips the probe.
    if (cfg.nodeVersion && /^v?\d+\.\d+\.\d+/.test(cfg.nodeVersion)) {
      probes.nodeVersion = cfg.nodeVersion.startsWith("v") ? cfg.nodeVersion : "v" + cfg.nodeVersion;
    }

    // Probe the remote CPU arch so the system-prompt Env block
    // (`Architecture: ${process.arch}`) and qoder's native-binary selection
    // (`${arm64?"aarch64":x64?"x86_64":arch}_${platform}`) match the remote, not the host.
    // On an x64 Windows host talking to an arm64 remote, the host's process.arch=x64 would
    // make qoder pick the wrong native binary (x86_64_linux) and misreport the arch.
    // uname -m → Node arch mapping; unknown → leave host arch untouched.
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
    if (cached && cached.arch) {
      probes.arch = cached.arch;
    } else {
      try {
        const a = mapArch(sftp.sftpExec("uname -m").stdout.toString("utf8"));
        if (a) probes.arch = a;
      } catch (e) {
        logger.warn("uname -m probe failed: " + e.message + " — process.arch left untouched");
      }
    }
    // Explicit config override always wins and skips the probe.
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
    // Agent path: SFTP → probe → platform → exec-bridge → fs-bridge → debug.
    if (isAgentBundle) process.env.__REMOTE_AGENT_CHILD = "1";

    const transportMod = cfg.transport === "http" ? require("./http-client") : require("./sftp-client");
    const transportLabel = cfg.transport === "http" ? "HTTP" : "SFTP";
    const { create } = transportMod;
    let _t0 = Date.now();
    let _fsBridgeRefresh = null;
    const sftp = create(cfg, (type, msg, extra) => {
      const dt = Date.now() - _t0;
      if (type === "ready") {
        logger.info(transportLabel + " ready", { ms: dt, workerMs: msg || "?" });
        if (_fsBridgeRefresh) _fsBridgeRefresh();
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
    _fsBridgeRefresh = _fb.refreshProbesAsync;

    const debug = require("./debug-hooks");
    debug.install(plat.getVcwd, adapter);

    // Telemetry suppression: block the OTLP collector paths the adapter declares, at the
    // http.request/https.request layer. Default on (disableTelemetry defaults to true) —
    // telemetry is opt-in, not opt-out. Set disableTelemetry:false in config to allow it.
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
