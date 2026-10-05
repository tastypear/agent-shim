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

  // Streaming path: real-time stdout/stderr via /api/exec/stream (SSE, HTTP) or the
  // ssh2 exec channel (SSH). Keeps the event loop free (TUI responsive) and lets
  // long-running commands (grep on large files, builds) run past the sync 30s budget.
  //
  // Uses a native node helper process as a pipe: real.stdout → helper.stdin → helper.stdout.
  // qoder reads helper.stdout, which is a real OS pipe-backed Readable. "data" events
  // fire through the event loop (truly async), matching qoder's stream consumption —
  // unlike Readable.push() in flowing mode which emits "data" synchronously.
  if (global.__sftpExecStream && !process.env.DISABLE_STREAM) {
    let real;
    try {
      real = global.__sftpExecStream(cmd);
    } catch (e) {
      const errBuf = Buffer.from(e.message + "\n");
      try { child.stderr.push(errBuf); } catch (_) {}
      if (_hasFdOut) writeToStdio(_errTarget, errBuf, child.stderr);
      try { child.stdout.push(null); } catch (_) {}
      try { child.stderr.push(null); } catch (_) {}
      process.nextTick(() => { child.emit("exit", 127, null); child.emit("close", 127, null); });
      return child;
    }

    // Spawn a pipe helper: real.stdout → helper.stdin → helper.stdout.
    // helper.stdout is a real OS pipe — "data" fires through the event loop (async).
    // Forward to child.stdout (original Readable qoder reads) via nextTick push,
    // matching the sync path where "data" events fire async after on("data") attaches.
    const helper = _nativeSpawn.call(require("child_process"), process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

    child.pid = (real && real.pid != null) ? real.pid : (helper.pid || -1);
    child.kill = (sig) => {
      try { real && real.kill(sig); } catch (_) {}
      try { helper.kill(sig); } catch (_) {}
      return true;
    };

    if (real.stdout) real.stdout.pipe(helper.stdin);
    helper.stdout.on("data", (c) => {
      if (_hasFdOut) writeToStdio(_outTarget, c, child.stdout);
      process.nextTick(() => { try { child.stdout.push(c); } catch (_) {} });
    });
    let stderrBuf = Buffer.alloc(0);
    if (real.stderr) real.stderr.on("data", (c) => {
      stderrBuf = Buffer.concat([stderrBuf, c]);
      if (_hasFdOut) writeToStdio(_errTarget, c, child.stderr);
    });

    let closed = false;
    const finish = (code, sig) => {
      if (closed) return; closed = true;
      try { child.stdout.push(null); } catch (_) {}
      if (stderrBuf.length) { try { child.stderr.push(stderrBuf); } catch (_) {} }
      try { child.stderr.push(null); } catch (_) {}
      const ec = code != null ? code : 0;
      child.emit("exit", ec, sig || null);
      child.emit("close", ec, sig || null);
    };

    if (real) {
      real.on("exit", (code, sig) => {
        try { helper.stdin.end(); } catch (_) {}
        helper.on("close", () => finish(code, sig));
        setTimeout(() => finish(code, sig), 5000);
      });
      real.on("error", (err) => {
        try { helper.kill(); } catch (_) {}
        const errBuf = Buffer.from(err.message + "\n");
        if (_hasFdOut) writeToStdio(_errTarget, errBuf, child.stderr);
        stderrBuf = Buffer.concat([stderrBuf, errBuf]);
        finish(127, null);
      });
      if (real.pid == null) real.on("spawn", () => { if (real.pid != null) child.pid = real.pid; });
    } else {
      try { helper.kill(); } catch (_) {}
      finish(127, null);
    }
    return child;
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
