const { Readable, Writable } = require("stream");
const { EventEmitter } = require("events");
const { writeToStdio } = require("./local-bash");
const { trace, stdioDesc } = require("./trace");

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
      trace("spawn ASYNC(pipe) result: cmd="+JSON.stringify(String(cmd).slice(0,80))+" stdio="+stdioDesc(opts)+" stdoutLen="+(r&&r.stdout?r.stdout.length:0)+" exit="+(r?r.exitCode:"?"));
      finish(null, r);
    }, (e) => {
      trace("spawn ASYNC(pipe) error: "+e.message);
      finish(e, null);
    });
    return child;
  }

  if (global.__sftpExec) {
    let r;
    try {
      r = global.__sftpExec(cmd);
      trace("spawn SYNC result: cmd="+JSON.stringify(String(cmd).slice(0,80))+" stdio="+stdioDesc(opts)+" hasFdOut="+_hasFdOut+" stdoutLen="+(r.stdout?r.stdout.length:0)+" exit="+(r.exitCode||0));
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
      trace("spawn SYNC error: "+err.message);
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
