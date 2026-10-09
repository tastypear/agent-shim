const { Readable, Writable } = require("stream");
const { EventEmitter } = require("events");
const { writeToStdio } = require("./local-bash");
const _log = require("../logger");
const logger = _log.child("exec.sync");
const { stdioDesc } = _log;
// Save native spawn before exec-bridge patches child_process.spawn — used to spawn
// the pipe helper for the streaming path, bypassing exec routing.
const _nativeSpawn = require("child_process").spawn;

function makeSftpExecChild(cmd, opts) {
  const _stdio = (opts && opts.stdio) || "pipe";
  const _outTarget = Array.isArray(_stdio) ? _stdio[1] : _stdio;
  const _errTarget = Array.isArray(_stdio) ? _stdio[2] : _stdio;
  const _hasFdOut =
    typeof _outTarget === "number" ||
    (typeof _outTarget === "object" && _outTarget && typeof _outTarget.write === "function");

  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({ write(c, e, d) { d(); } });
  child.pid = -1;
  child.unref = () => child;
  child.ref = () => child;
  child.kill = () => true;

  // Check exec cache before spawning subprocess — if the command was
  // prefetched, serve from cache without spawning a real subprocess.
  if (process.env.AGENT_SHIM_CACHE_DEBUG) console.error("[exec-bridge] makeSftpExecChild: cmd=" + JSON.stringify(String(cmd).slice(0,150)) + " cacheHit=" + (global.__sftpExecCache && global.__sftpExecCache.has(cmd)));
  if (global.__sftpExecCache && global.__sftpExecCache.has(cmd)) {
    const r = global.__sftpExecCache.get(cmd);
    logger.trace("spawn CACHED: cmd=" + JSON.stringify(String(cmd).slice(0, 80)));
    process.nextTick(() => {
      if (r.stdout && r.stdout.length) { try { child.stdout.push(r.stdout); } catch (e) {} }
      if (r.stderr && r.stderr.length) { try { child.stderr.push(r.stderr); } catch (e) {} }
      if (_hasFdOut) {
        if (r.stdout && r.stdout.length) writeToStdio(_outTarget, r.stdout, child.stdout);
        if (r.stderr && r.stderr.length) writeToStdio(_errTarget, r.stderr, child.stderr);
      }
      try { child.stdout.push(null); } catch (e) {}
      try { child.stderr.push(null); } catch (e) {}
      child.emit("exit", r.exitCode || 0, null);
      child.emit("close", r.exitCode || 0, null);
    });
    return child;
  }

  // Streaming path: spawn a REAL subprocess (stream-helper.js) that runs the
  // remote command via remote-cp-node's streaming spawn and pipes output to its
  // own stdout/stderr. qoder's stdio (e.g. ["pipe", fd7, fd7]) is passed through
  // directly, so the helper's stdout IS fd7 — qoder reads fd7 via the OS, exactly
  // like local execution. No fake ChildProcess, no fake Readable, no push().
  //
  // This is the pure subprocess proxy: qoder sees a real ChildProcess returned by
  // native spawn, identical to what it gets for local commands.
  if (global.__sftpExecStream && !process.env.DISABLE_STREAM) {
    const info = global.__sftpExecStreamInfo;
    // Strip NODE_OPTIONS so the helper doesn't re-load agent-shim (which would
    // log to stderr/fd and pollute the command output).
    const helperEnv = Object.assign({}, process.env);
    delete helperEnv.NODE_OPTIONS;
    if (info && info.baseURL) {
      const path = require("path");
      const helperScript = path.join(__dirname, "stream-helper.js");
      let modulePath;
      try { modulePath = require.resolve("remote-cp-node"); } catch (_) {}
      if (modulePath) {
        const cp = require("child_process");
        const helperOpts = {
          stdio: opts && opts.stdio ? opts.stdio : "pipe",
          windowsHide: true,
          env: helperEnv,
        };
        logger.trace("spawn STREAM(subprocess): cmd=" + JSON.stringify(String(cmd).slice(0, 80)));
        return _nativeSpawn.call(cp, process.execPath,
          [helperScript, cmd, info.baseURL, info.token || "", modulePath], helperOpts);
      }
    }
    if (info && info.ssh) {
      const path = require("path");
      const helperScript = path.join(__dirname, "stream-helper-ssh.js");
      const cp = require("child_process");
      const helperOpts = {
        stdio: opts && opts.stdio ? opts.stdio : "pipe",
        windowsHide: true,
        env: helperEnv,
      };
      logger.trace("spawn STREAM-SSH(subprocess): cmd=" + JSON.stringify(String(cmd).slice(0, 80)));
      return _nativeSpawn.call(cp, process.execPath,
        [helperScript, cmd, JSON.stringify(info.ssh)], helperOpts);
    }
    // No stream info — fall through to sync/async paths below.
  }

  const _useSync = _hasFdOut || !global.__sftpExecAsync;

  if (!_useSync && global.__sftpExecAsync) {
    let settled = false;
    const finish = (err, r) => {
      if (settled) return;
      settled = true;
      if (err || !r) {
        const em = err ? err.message : "SFTP exec failed";
        const errBuf = Buffer.from(em + "\n");
        try { child.stderr.push(errBuf); } catch (e) {}
        try { child.stdout.push(null); } catch (e) {}
        try { child.stderr.push(null); } catch (e) {}
        child.emit("exit", 127, null);
        child.emit("close", 127, null);
        return;
      }
      if (r.stdout && r.stdout.length) { try { child.stdout.push(r.stdout); } catch (e) {} }
      if (r.stderr && r.stderr.length) { try { child.stderr.push(r.stderr); } catch (e) {} }
      try { child.stdout.push(null); } catch (e) {}
      try { child.stderr.push(null); } catch (e) {}
      const ec = r.exitCode || 0;
      child.emit("exit", ec, null);
      child.emit("close", ec, null);
    };
    global.__sftpExecAsync(cmd).then((r) => {
      logger.trace("spawn ASYNC(pipe) result: cmd="+JSON.stringify(String(cmd).slice(0,80))+" stdio="+stdioDesc(opts)+" stdoutLen="+(r&&r.stdout?r.stdout.length:0)+" exit="+(r?r.exitCode:"?"));
      finish(null, r);
    }, (e) => {
      logger.trace("spawn ASYNC(pipe) error: "+e.message);
      finish(e, null);
    });
    return child;
  }

  if (global.__sftpExec) {
    let r;
    try {
      r = global.__sftpExec(cmd);
      logger.trace("spawn SYNC result: cmd="+JSON.stringify(String(cmd).slice(0,80))+" stdio="+stdioDesc(opts)+" hasFdOut="+_hasFdOut+" stdoutLen="+(r.stdout?r.stdout.length:0)+" exit="+(r.exitCode||0));
      if (r.stdout && r.stdout.length) { try { child.stdout.push(r.stdout); } catch (e) {} }
      if (r.stderr && r.stderr.length) { try { child.stderr.push(r.stderr); } catch (e) {} }
      if (_hasFdOut) {
        if (r.stdout && r.stdout.length) writeToStdio(_outTarget, r.stdout, child.stdout);
        if (r.stderr && r.stderr.length) writeToStdio(_errTarget, r.stderr, child.stderr);
      }
      try { child.stdout.push(null); } catch (e) {}
      try { child.stderr.push(null); } catch (e) {}
      process.nextTick(() => {
        child.emit("exit", r.exitCode || 0, null);
        child.emit("close", r.exitCode || 0, null);
      });
    } catch (err) {
      logger.trace("spawn SYNC error: "+err.message);
      const errBuf = Buffer.from(err.message + "\n");
      try { child.stderr.push(errBuf); } catch (e) {}
      if (_hasFdOut) writeToStdio(_errTarget, errBuf, child.stderr);
      try { child.stdout.push(null); } catch (e) {}
      try { child.stderr.push(null); } catch (e) {}
      process.nextTick(() => {
        child.emit("exit", 127, null);
        child.emit("close", 127, null);
      });
    }
    return child;
  }

  process.nextTick(() => {
    const errBuf = Buffer.from("SFTP exec unavailable (worker not ready) — refused: " + cmd + "\n");
    try { child.stderr.push(errBuf); } catch (e) {}
    if (_hasFdOut) writeToStdio(_errTarget, errBuf, child.stderr);
    try { child.stderr.push(null); } catch (e) {}
    try { child.stdout.push(null); } catch (e) {}
    child.emit("exit", 127, null);
    child.emit("close", 127, null);
  });
  return child;
}

module.exports = { makeSftpExecChild };
