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

  // Non-invasive ESM load hook: patches qodercli.js in memory (no file edit). General patches
  // (BYOK unlock/activation) apply in both local and remote mode unless DISABLE_BYOK is set.
  // Remote-only patches (prefix stripping) apply only when AGENT_SHIM_REMOTE=1 (set after config
  // load below) and not DISABLE_REMOTE_DISPLAY. Registered BEFORE the remote-control bail because
  // RC workers inherit NODE_OPTIONS + process.env, load this shim, and need the patches; they bail
  // below, but the hook is already installed. Main thread only — worker_threads re-enter this file
  // but don't load the qodercli.js entry, and re-registering would warn.
  if (!process.env.DISABLE_BYOK || !process.env.DISABLE_REMOTE_DISPLAY) {
    let _isMain = true;
    try { _isMain = require("worker_threads").isMainThread; } catch (_) {}
    if (_isMain) {
      try {
        const { register } = require("module");
        const { pathToFileURL } = require("url");
        const hookUrl = pathToFileURL(require("path").join(__dirname, "qoder-hook.mjs")).href;
        const bundlePath = require("path").join(require("os").homedir(), "AppData/Roaming/npm/node_modules/@qoder-ai/qodercli/bundle/qodercli.js");
        if (fs.existsSync(bundlePath)) {
          register(hookUrl, { data: { bundleUrl: pathToFileURL(bundlePath).href } });
          logger.info("qoder patch hook registered (non-invasive)");
        } else {
          logger.warn("qoder patch hook: qodercli.js not found at " + bundlePath);
        }
      } catch (e) {
        logger.warn("qoder patch hook registration failed: " + (e && e.message));
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

  // Signal the ESM hook whether remote-only patches should apply.
  process.env.AGENT_SHIM_REMOTE = cfg ? "1" : "0";

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

  // Local mode: no remote config file and no connection env vars. Patches are
  // already active (ESM hook registered above). Block telemetry unless DISABLE_TELEMETRY_BLOCK,
  // then let qoder run natively on Windows — no platform faking, no fs/exec bridge, no transport.
  if (!cfg) {
    if (!process.env.DISABLE_TELEMETRY_BLOCK && adapter && adapter.getTelemetryBlockPaths) {
      const paths = adapter.getTelemetryBlockPaths();
      if (paths && paths.length) {
        require("./core/net-block").install(paths);
        logger.info("local mode: telemetry blocked (paths: " + paths.join(", ") + ")");
      }
    }
    logger.info("local mode: no remote config — patches active, running natively");
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

    // Batch all needed probes into a single exec call.
    const batch = {};
    if (typeof sftp.sftpExecBatch === "function") {
      // HTTP mode: native batch exec API (parallel, per-command results)
      const cmds = [], tags = [];
      if (needHome)    { cmds.push('printf "%s" "$HOME"');            tags.push("H"); }
      if (needUnameR)  { cmds.push('uname -r 2>/dev/null');            tags.push("R"); }
      if (needNodeV)   { cmds.push('node --version 2>/dev/null');      tags.push("N"); }
      if (needUnameM)  { cmds.push('uname -m 2>/dev/null');            tags.push("M"); }
      if (cmds.length > 0) {
        try {
          const results = sftp.sftpExecBatch(cmds, { mode: "parallel" });
          for (let i = 0; i < results.length; i++) {
            batch[tags[i]] = results[i].stdout.toString("utf8").trim();
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
    } else {
      // SSH mode: printf-tagged commands joined into one shell call
      const cmds = [];
      if (needHome)    cmds.push('printf "H\\t%s\\n" "$HOME"');
      if (needUnameR)  cmds.push('printf "R\\t%s\\n" "$(uname -r 2>/dev/null)"');
      if (needNodeV)   cmds.push('printf "N\\t%s\\n" "$(node --version 2>/dev/null)"');
      if (needUnameM)  cmds.push('printf "M\\t%s\\n" "$(uname -m 2>/dev/null)"');
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
    if (cfg.osRelease) {
      probes.osRelease = cfg.osRelease;
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
      // HTTP mode: remote-fs-node patches fs at the binding level, remote-cp-node handles exec.
      // No fs-bridge needed — remote-fs-node IS the fs bridge.
      const debugCapture = require("./debug-capture");
      debugCapture.install();

      const { isRemote, toRemote } = require("./classifier");
      const baseURL = (cfg.tls ? "https://" : "http://") +
        (cfg.host.includes(":") ? "[" + cfg.host + "]" : cfg.host) + ":" + (cfg.port || 8765);

      // Configure remote-cp-node for exec transport (syncBridge, not curl).
      const remoteCp = require("remote-cp-node");
      remoteCp.configure({ baseURL, token: cfg.token });
      const cpClient = remoteCp.client;

      // Create exec object consumed by resolveProbes and exec-bridge.
      const exec = {
        sftpExec: function (cmd) {
          const r = cpClient.postJSONSync("/api/exec", { cmd, shell: true });
          return {
            stdout: Buffer.from(r.stdout || ""),
            stderr: Buffer.from(r.stderr || ""),
            exitCode: r.exit_code != null ? r.exit_code : 0,
          };
        },
        sftpExecAsync: function (cmd) {
          return cpClient.postJSON("/api/exec", { cmd, shell: true }).then(function (r) {
            return {
              stdout: Buffer.from(r.stdout || ""),
              stderr: Buffer.from(r.stderr || ""),
              exitCode: r.exit_code != null ? r.exit_code : 0,
            };
          });
        },
        sftpExecBatch: function (cmds, opts) {
          const r = cpClient.batchSync(cmds, opts || {});
          return r.results.map(function (res) {
            return {
              stdout: Buffer.from(res.stdout || ""),
              stderr: Buffer.from(res.stderr || ""),
              exitCode: res.exit_code != null ? res.exit_code : 0,
            };
          });
        },
      };
      global.__sftpExec = exec.sftpExec;
      global.__sftpExecAsync = exec.sftpExecAsync;
      // Streaming exec (spawn): makeSftpExecChild spawns a REAL subprocess
      // (stream-helper.js) that runs the remote command via remote-cp-node's
      // streaming spawn and pipes output to its own stdout/stderr (the fds qoder
      // passed). qoder sees a real ChildProcess — identical to local execution.
      // The command string already carries `cd '<rc>' &&` (wrapSpawn).
      global.__sftpExecStream = true;
      global.__sftpExecStreamInfo = { baseURL: baseURL, token: cfg.token };

      const remoteFs = require("remote-fs-node");
      remoteFs.configure({ baseURL, token: cfg.token, shouldRemote: isRemote, pathTransform: toRemote });
      remoteFs.patch({ patchSync: true, skipBinding: process.env.AGENT_SHIM_NO_BINDING === "1" });

      // Consumer-side cache: 60s TTL on existsSync/statSync/lstatSync,
      // realpath as string transform (no server call), cache invalidation on mutations.
      // Sits above remote-fs-node's binding-level patch, matching SSH mode's fs-bridge layer.
      const httpCache = require("./http-cache");
      httpCache.install(require("fs"), isRemote);

      // HTTP transport debug logger — captures all wire-level requests/responses
      // from both remote-cp-node and remote-fs-node. Enabled via
      // AGENT_SHIM_DEBUG_HTTP=<path> (or "1" for default path).
      if (process.env.AGENT_SHIM_DEBUG_HTTP) {
        var httpDebugPath = process.env.AGENT_SHIM_DEBUG_HTTP === "1"
          ? require("path").join(__dirname, "..", ".agent-shim-http-debug.log")
          : process.env.AGENT_SHIM_DEBUG_HTTP;
        var realFs_ = debugCapture.realFs;
        var httpDebugFn = function (ev) {
          try { realFs_.appendFileSync(httpDebugPath, JSON.stringify({ ts: Date.now(), ...ev }) + "\n"); } catch (e) {}
        };
        cpClient.setDebugLogger(httpDebugFn);
        remoteFs.client.setDebugLogger(httpDebugFn);
      }

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

      require("./qoder-local-fs").install(plat.getVcwd && plat.getVcwd());

      // Exec prefetch: cache known commands (editor probes) at startup so
      // individual execSync calls from qoder hit the cache instead of the server.
      var _execCache = new Map();
      global.__sftpExecCache = _execCache;
      var _origSftpExec = exec.sftpExec;
      exec.sftpExec = function (cmd) {
        if (process.env.AGENT_SHIM_CACHE_DEBUG) console.error("[exec-cache] sync lookup: " + JSON.stringify(String(cmd).slice(0,150)) + " hit=" + _execCache.has(cmd));
        if (_execCache.has(cmd)) return _execCache.get(cmd);
        return _origSftpExec(cmd);
      };
      global.__sftpExec = exec.sftpExec;
      var _origSftpExecAsync = exec.sftpExecAsync;
      exec.sftpExecAsync = function (cmd) {
        if (process.env.AGENT_SHIM_CACHE_DEBUG) console.error("[exec-cache] async lookup: " + JSON.stringify(String(cmd).slice(0,150)) + " hit=" + _execCache.has(cmd));
        if (_execCache.has(cmd)) return Promise.resolve(_execCache.get(cmd));
        return _origSftpExecAsync(cmd);
      };
      global.__sftpExecAsync = exec.sftpExecAsync;

      if (adapter && adapter.getPrefetchCommands && exec.sftpExecBatch) {
        try {
          var rc = plat.getRemoteCwd();
          var pfCmds = adapter.getPrefetchCommands(rc);
          var pfResults = exec.sftpExecBatch(pfCmds, { mode: "parallel" });
          for (var i = 0; i < pfCmds.length && i < pfResults.length; i++) {
            _execCache.set(pfCmds[i], pfResults[i]);
          }
          if (pfCmds.length) logger.info("exec prefetch: " + pfCmds.length + " cmds (batch exec)");
        } catch (e) { logger.warn("exec prefetch failed: " + e.message); }
      }

      const execBridge = require("./exec-bridge");
      execBridge.apply(adapter, plat.getRemoteCwd);
      const pfN = httpCache.prefetchStartup(exec, cfg, adapter, plat.getRemoteCwd);
      if (pfN) logger.info("startup prefetch: " + pfN + " ops (batch API)");
      const debug = require("./debug-hooks");
      debug.install(plat.getVcwd, adapter);

      if (cfg.disableTelemetry !== false && !process.env.DISABLE_TELEMETRY_BLOCK && adapter && adapter.getTelemetryBlockPaths) {
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
      // Streaming exec (spawn): makeSftpExecChild spawns a REAL subprocess
      // (stream-helper-ssh.js) that connects via ssh2, runs conn.exec(cmd), and
      // pipes output to its own stdout/stderr (the fds qoder passed). qoder sees
      // a real ChildProcess — identical to local execution. The command string
      // already carries `cd '<rc>' &&` (wrapSpawn).
      global.__sftpExecStream = true;
      global.__sftpExecStreamInfo = {
        ssh: {
          host: cfg.host,
          port: cfg.port,
          user: cfg.user,
          keyPath: cfg.keyPath,
          ssh2Path: cfg.ssh2Path,
          keepaliveInterval: cfg.keepaliveInterval,
          readyTimeout: cfg.readyTimeout,
          socksProxy: cfg.socksProxy || "",
        },
      };

      const probes = resolveProbes(sftp, cfg, adapter);
      const platform = require("./platform");
      const plat = platform.apply(cfg, adapter, probes);
      const execBridge = require("./exec-bridge");
      execBridge.apply(adapter, plat.getRemoteCwd);
      const fsBridge = require("./fs-bridge");
      const _fb = fsBridge.apply(sftp, plat.getRemoteCwd, cfg, adapter, probes);
      const pfN = _fb.prefetchStartup();
      if (pfN) logger.info("startup prefetch: " + pfN + " ops (batch API)");

      require("./qoder-local-fs").install(plat.getVcwd && plat.getVcwd());

      const debug = require("./debug-hooks");
      debug.install(plat.getVcwd, adapter);

      if (cfg.disableTelemetry !== false && !process.env.DISABLE_TELEMETRY_BLOCK && adapter && adapter.getTelemetryBlockPaths) {
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
