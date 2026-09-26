function install(ctx) {
  const { fs, O, isRemote, toRemote, sExists, isVirtualFd } = ctx;

  function wrapAsync(syncFn, origAsync) {
    return function (p, a, b, c) {
      let opts, cb;
      if (typeof a === "function") {
        cb = a;
        opts = undefined;
      } else {
        opts = a;
        cb = b;
      }
      if (!cb && typeof c === "function") cb = c;
      if (typeof cb !== "function") {
        return new Promise((res, rej) => {
          try {
            res(syncFn.call(this, p, opts));
          } catch (e) {
            rej(e);
          }
        });
      }
      if (isRemote(p)) {
        try {
          const r = syncFn.call(this, p, opts);
          process.nextTick(() => cb(null, r));
        } catch (e) {
          process.nextTick(() => cb(e));
        }
        return;
      }
      return origAsync.call(this, p, a, b, c);
    };
  }
  // fd-based async ops (fsync/fdatasync/fstat/ftruncate/fchmod/fchown/futimes) receive a
  // virtual fd from openSync as the first arg, not a path — wrapAsync won't fit. For virtual
  // fds, delegate to the patched sync version (which no-ops or reads the entry); for real
  // fds, forward all original arguments to the native async impl unchanged. Handles variadic
  // arg counts (e.g. fchown(fd, uid, gid, cb)) by treating a trailing function as the callback.
  function wrapFdAsync(syncFn, origAsync) {
    return function (fd, ...rest) {
      if (!isVirtualFd(fd)) return origAsync.apply(this, arguments);
      let cb = null;
      const args = [];
      for (let i = 0; i < rest.length; i++) {
        if (typeof rest[i] === "function" && i === rest.length - 1) cb = rest[i];
        else args.push(rest[i]);
      }
      if (cb !== null) {
        try { const r = syncFn.call(this, fd, ...args); process.nextTick(() => cb(null, r)); }
        catch (e) { process.nextTick(() => cb(e)); }
        return;
      }
      return new Promise((res, rej) => {
        try { res(syncFn.call(this, fd, ...args)); } catch (e) { rej(e); }
      });
    };
  }
  fs.readFile = wrapAsync(fs.readFileSync, O.readFile);
  fs.writeFile = wrapAsync((p, d, o) => { fs.writeFileSync(p, d, o); return undefined; }, O.writeFile);
  fs.stat = wrapAsync(fs.statSync, O.stat);
  fs.lstat = wrapAsync(fs.lstatSync, O.lstat);
  fs.readdir = wrapAsync(fs.readdirSync, O.readdir);
  fs.access = wrapAsync((p, m) => { fs.accessSync(p, m); return undefined; }, O.access);
  fs.mkdir = wrapAsync((p, o) => { fs.mkdirSync(p, o); return undefined; }, O.mkdir);
  fs.unlink = wrapAsync((p) => { fs.unlinkSync(p); return undefined; }, O.unlink);
  fs.rename = wrapAsync((o, n) => { fs.renameSync(o, n); return undefined; }, O.rename);
  fs.copyFile = wrapAsync((s, d, m) => { fs.copyFileSync(s, d, m); return undefined; }, O.copyFile);
  fs.appendFile = wrapAsync((p, d, o) => { fs.appendFileSync(p, d, o); return undefined; }, O.appendFile);
  fs.rm = wrapAsync((p, o) => { fs.rmSync(p, o); return undefined; }, O.rm);
  // proper-lockfile's release path calls fs.rmdir(lockDirPath, ()=>{}) — async, with
  // the error swallowed by the callback. Without a patch, the virtual-prefixed lock
  // dir path hits native fs.rmdir -> ENOENT, the lock is never released on the remote,
  // and the NEXT save fails to acquire it ("first save ok, second save errors").
  // Delegate to fs.rmdirSync (already routes remote dirs via OP.rmdir).
  if (O.rmdir) fs.rmdir = wrapAsync((p) => { fs.rmdirSync(p); return undefined; }, O.rmdir);
  if (O.realpath) fs.realpath = wrapAsync((p) => fs.realpathSync(p), O.realpath);
  if (fs.realpath) {
    Object.defineProperty(fs.realpath, "native", {
      value: fs.realpath,
      writable: false,
      configurable: false,
    });
  }
  if (O.readlink) fs.readlink = wrapAsync((p, opts) => fs.readlinkSync(p, opts), O.readlink);
  if (O.symlink) fs.symlink = wrapAsync((target, p) => { fs.symlinkSync(target, p); return undefined; }, O.symlink);
  if (O.utimes) fs.utimes = (p, atime, mtime, cb) => {
    if (typeof cb !== "function") return new Promise((res, rej) => { try { fs.utimesSync(p, atime, mtime); res(); } catch (e) { rej(e); } });
    try { fs.utimesSync(p, atime, mtime); process.nextTick(() => cb(null)); } catch (e) { process.nextTick(() => cb(e)); }
  };
  if (O.chmod) fs.chmod = (p, mode, cb) => {
    if (typeof cb !== "function") return new Promise((res, rej) => { try { fs.chmodSync(p, mode); res(); } catch (e) { rej(e); } });
    try { fs.chmodSync(p, mode); process.nextTick(() => cb(null)); } catch (e) { process.nextTick(() => cb(e)); }
  };
  fs.exists = (p, cb) => {
    if (typeof cb === "function") {
      process.nextTick(() => cb(isRemote(p) ? sExists(toRemote(p)) : O.existsSync.call(fs, p)));
      return;
    }
    return isRemote(p) ? sExists(toRemote(p)) : O.existsSync.call(fs, p);
  };
  if (O.fsync) fs.fsync = wrapFdAsync(fs.fsyncSync, O.fsync);
  if (O.fdatasync) fs.fdatasync = wrapFdAsync(fs.fdatasyncSync, O.fdatasync);
  if (O.fstat) fs.fstat = wrapFdAsync(fs.fstatSync, O.fstat);
  if (O.ftruncate) fs.ftruncate = wrapFdAsync(fs.ftruncateSync, O.ftruncate);
  if (O.fchmod) fs.fchmod = wrapFdAsync(fs.fchmodSync, O.fchmod);
  if (O.fchown) fs.fchown = wrapFdAsync(fs.fchownSync, O.fchown);
  if (O.futimes) fs.futimes = wrapFdAsync(fs.futimesSync, O.futimes);
}

module.exports = { install };
