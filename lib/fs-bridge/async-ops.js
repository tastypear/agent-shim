function install(ctx) {
  const { fs, O, isRemote, toRemote, sExists } = ctx;

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
}

module.exports = { install };
