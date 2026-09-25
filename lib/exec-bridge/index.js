const cp = require("child_process");
const _log = require("../logger");
const logger = _log.child("exec");
const { stdioDesc } = _log;
const { wrapSpawn, routeExecCommand } = require("./routing");
const { makeSftpExecChild } = require("./sync-child");
const { makeExecResultChild, execResultSync } = require("./async-child");
const { localBashExecOpts } = require("./local-bash");

function apply(adapter, getRemoteCwd) {
  const localBash = adapter.getLocalBash();
  const _spawn = cp.spawn;
  const _spawnSync = cp.spawnSync;
  const _exec = cp.exec;
  const _execSync = cp.execSync;
  const _execFile = cp.execFile;
  const _execFileSync = cp.execFileSync;

  cp.spawn = function (exe, args, opts) {
    {
      const _a1 = String((args && args[1]) || "");
      const _a1Bytes = Buffer.byteLength(_a1, "utf8");
      logger.trace("spawn CALL: exe=" + JSON.stringify(String(exe || "")) + " args=" + JSON.stringify(args && args.slice(0, 3)) + " cwd=" + JSON.stringify(opts && opts.cwd) + " stdio=" + stdioDesc(opts) + (_a1Bytes !== _a1.length ? " a1Bytes=" + _a1Bytes + "/jsLen=" + _a1.length : ""));
    }
    if (exe === "__sftp_exec__") return makeSftpExecChild(args[0], opts);

    const intercepted = adapter.interceptSpawn(exe, args, opts);
    if (intercepted) {
      logger.trace("spawn -> adapter intercept");
      return intercepted;
    }

    const w = wrapSpawn(exe, args, opts, adapter, getRemoteCwd);
    if (w) {
      if (w.exe === "__sftp_exec__") {
        logger.trace("spawn -> sftpExec: cmd="+JSON.stringify(String(w.args[0]||"").slice(0,80)));
        return makeSftpExecChild(w.args[0], w.opts);
      }
      logger.trace("spawn -> localBash: exe="+JSON.stringify(String(w.exe).slice(0,50)));
      return _spawn.call(cp, w.exe, w.args, w.opts);
    }
    logger.trace("spawn -> passthrough native");
    return _spawn.call(cp, exe, args, opts);
  };

  cp.spawnSync = function (exe, args, opts) {
    logger.trace("spawnSync CALL: exe="+JSON.stringify(String(exe||"").slice(0,50))+" a0="+JSON.stringify(String(args&&args[0]||"").slice(0,30))+" a1="+JSON.stringify(String(args&&args[1]||"").slice(0,60))+" stdio="+stdioDesc(opts)+" enc="+(opts&&(typeof opts==="string"?opts:opts.encoding)||"default"));
    const w = wrapSpawn(exe, args, opts, adapter, getRemoteCwd);
    if (w && w.exe === "__sftp_exec__") {
      if (global.__sftpExec) {
        const _ssT = Date.now();
        try {
          const r = global.__sftpExec(w.args[0]);
          logger.trace("spawnSync result: cmd="+JSON.stringify(String(w.args[0]||"").slice(0,60))+" -> "+(Date.now()-_ssT)+"ms stdoutLen="+r.stdout.length+" exit="+(r.exitCode||0));
          const enc = opts && (typeof opts === "string" ? opts : opts.encoding);
          const out = enc ? r.stdout.toString(enc) : r.stdout;
          const err = enc ? r.stderr.toString(enc) : r.stderr;
          return { status: r.exitCode || 0, stdout: out, stderr: err, pid: 0 };
        } catch (e) {
          logger.trace("spawnSync ERR: "+e.message);
          return { status: 127, stdout: Buffer.alloc(0), stderr: Buffer.from(e.message + "\n"), pid: 0 };
        }
      }
      logger.trace("spawnSync -> sftpExec unavailable");
      return {
        status: 127,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("SFTP exec unavailable (worker not ready) — refused\n"),
        pid: 0,
      };
    }
    logger.trace("spawnSync -> "+(w?"localBash":"passthrough"));
    return w ? _spawnSync.call(cp, w.exe, w.args, w.opts) : _spawnSync.call(cp, exe, args, opts);
  };

  cp.exec = function (command, opts, callback) {
    let _opts = opts;
    let _cb = callback;
    if (typeof opts === "function") {
      _cb = opts;
      _opts = undefined;
    }
    logger.trace("exec CALL: cmd="+JSON.stringify(String(command||"").slice(0,80))+" stdio="+stdioDesc(_opts));
    const cmd = routeExecCommand(command, null, null, _opts, adapter, getRemoteCwd);
    if (cmd !== null) {
      if (typeof cmd === "object" && cmd.__localBash) {
        logger.trace("exec -> localBash");
        const o = localBashExecOpts(_opts, localBash);
        return _exec.call(cp, cmd.cmd, o, _cb);
      }
      logger.trace("exec -> sftpExec: "+JSON.stringify(String(cmd).slice(0,80)));
      return makeExecResultChild(cmd, _opts, _cb);
    }
    logger.trace("exec -> passthrough");
    return _exec.call(cp, command, _opts, _cb);
  };

  cp.execSync = function (command, opts) {
    logger.trace("execSync CALL: cmd="+JSON.stringify(String(command||"").slice(0,80)));
    const cmd = routeExecCommand(command, null, null, opts, adapter, getRemoteCwd);
    if (cmd !== null) {
      if (typeof cmd === "object" && cmd.__localBash) {
        logger.trace("execSync -> localBash");
        const o = localBashExecOpts(opts, localBash);
        return _execSync.call(cp, cmd.cmd, o);
      }
      const r = execResultSync(cmd, opts);
      logger.trace("execSync result: "+JSON.stringify(String(cmd).slice(0,60))+" stdoutLen="+(r?Buffer.byteLength(r):0));
      if (r !== null) return r;
    }
    logger.trace("execSync -> passthrough");
    return _execSync.call(cp, command, opts);
  };

  cp.execFile = function (file, args, opts, callback) {
    let _args = args;
    let _opts = opts;
    let _cb = callback;
    if (typeof args === "function") {
      _cb = args;
      _args = undefined;
      _opts = undefined;
    } else if (typeof opts === "function") {
      _cb = opts;
      _opts = undefined;
    }
    const argList = Array.isArray(_args) ? _args : [];
    logger.trace("execFile CALL: file="+JSON.stringify(String(file||"").slice(0,50))+" a0="+JSON.stringify(String(argList[0]||"").slice(0,30))+" a1="+JSON.stringify(String(argList[1]||"").slice(0,60))+" stdio="+stdioDesc(_opts));
    const cmd = routeExecCommand(null, file, argList, _opts, adapter, getRemoteCwd);
    if (cmd !== null) {
      if (typeof cmd === "object" && cmd.__localBash) {
        logger.trace("execFile -> localBash");
        const o = localBashExecOpts(_opts, localBash);
        return _exec.call(cp, cmd.cmd, o, _cb);
      }
      logger.trace("execFile -> sftpExec: "+JSON.stringify(String(cmd).slice(0,80)));
      return makeExecResultChild(cmd, _opts, _cb);
    }
    logger.trace("execFile -> passthrough");
    return _execFile.call(cp, file, _args || [], _opts, _cb);
  };

  cp.execFileSync = function (file, args, opts) {
    const argList = Array.isArray(args) ? args : [];
    logger.trace("execFileSync CALL: file="+JSON.stringify(String(file||"").slice(0,50))+" a0="+JSON.stringify(String(argList[0]||"").slice(0,30))+" a1="+JSON.stringify(String(argList[1]||"").slice(0,60)));
    const cmd = routeExecCommand(null, file, argList, opts, adapter, getRemoteCwd);
    if (cmd !== null) {
      if (typeof cmd === "object" && cmd.__localBash) {
        logger.trace("execFileSync -> localBash");
        const o = localBashExecOpts(opts, localBash);
        return _execSync.call(cp, cmd.cmd, o);
      }
      const _efT = Date.now();
      const r = execResultSync(cmd, opts);
      logger.debug("execFileSync", { file, ms: Date.now()-_efT });
      if (r !== null) return r;
    }
    return _execFileSync.call(cp, file, args, opts);
  };

  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
    try {
      const patched = cp[name];
      Object.defineProperty(cp, name, {
        get: () => patched,
        set: () => {},
        configurable: false,
        enumerable: true,
      });
    } catch (e) {}
  }
}

module.exports = { apply };
