const { Readable, Writable } = require("stream");
const { EventEmitter } = require("events");
const logger = require("../logger").child("exec.async");

function makeExecResultChild(cmd, opts, callback) {
  const enc = (opts && (typeof opts === "string" ? opts : opts.encoding)) || "utf8";
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({ write(c, e, d) { d(); } });
  child.pid = -1;
  child.unref = () => child;
  child.ref = () => child;
  child.kill = () => true;

  const finish = (err, r) => {
    if (err) {
      const se = Buffer.from(err.message + "\n");
      child.stderr.push(se);
      child.stderr.push(null);
      child.stdout.push(null);
      child.emit("exit", 127, null);
      child.emit("close", 127, null);
      if (callback) callback(err, enc ? "" : Buffer.alloc(0), enc ? se.toString(enc) : se);
      return;
    }
    child.stdout.push(r.stdout);
    child.stdout.push(null);
    child.stderr.push(r.stderr);
    child.stderr.push(null);
    const ec = r.exitCode || 0;
    child.emit("exit", ec, null);
    child.emit("close", ec, null);
    if (callback) {
      const out = enc ? r.stdout.toString(enc) : r.stdout;
      const serr = enc ? r.stderr.toString(enc) : r.stderr;
      if (ec !== 0) {
        const ferr = new Error("Command failed: " + cmd + "\n" + r.stderr.toString("utf8"));
        ferr.code = ec;
        ferr.status = ec;
        ferr.stdout = r.stdout;
        ferr.stderr = r.stderr;
        callback(ferr, out, serr);
      } else {
        callback(null, out, serr);
      }
    }
  };

  if (global.__sftpExecAsync) {
    global.__sftpExecAsync(cmd).then((r) => {
      logger.trace("execFile/exec ASYNC result: cmd="+JSON.stringify(String(cmd).slice(0,80))+" stdoutLen="+(r&&r.stdout?r.stdout.length:0)+" exit="+(r?r.exitCode:"?")+" hasCb="+(!!callback));
      finish(null, r);
    }, (e) => {
      logger.trace("execFile/exec ASYNC error: "+e.message);
      finish(e, null);
    });
    return child;
  }
  process.nextTick(() => {
    let r;
    try {
      r = global.__sftpExec(cmd);
    } catch (err) {
      finish(err, null);
      return;
    }
    finish(null, r);
  });
  return child;
}

function execResultSync(cmd, opts) {
  if (!global.__sftpExec) return null;
  const r = global.__sftpExec(cmd);
  if (r.exitCode !== 0) {
    const err = new Error("Command failed: " + cmd + "\n" + r.stderr.toString("utf8"));
    err.status = r.exitCode;
    err.code = r.exitCode;
    err.stdout = r.stdout;
    err.stderr = r.stderr;
    throw err;
  }
  const enc = (opts && (typeof opts === "string" ? opts : opts.encoding)) || "utf8";
  return r.stdout.toString(enc);
}

module.exports = { makeExecResultChild, execResultSync };
