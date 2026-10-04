function install(ctx) {
  const { fs, path, isRemote, toRemote, sftpCall, sftpExec, OP, O, sRead, sWrite, sReaddir, sStat, sExists, cInv, cInvTree } = ctx;

  function eexist(p) {
    const e = new Error("EEXIST: file already exists, copyFile '" + toRemote(p) + "'");
    e.code = "EEXIST";
    return e;
  }
  function makeStat(p) {
    const s = sStat(p);
    return {
      size: s.size, mode: s.mode, dev: 0, ino: 0, nlink: 1, rdev: 0,
      blksize: 4096, blocks: 0, uid: s.uid || 0, gid: s.gid || 0,
      mtime: new Date(s.mtimeMs || 0), mtimeMs: s.mtimeMs || 0,
      ctime: new Date(s.ctimeMs || 0), ctimeMs: s.ctimeMs || 0,
      atime: new Date(s.atimeMs || 0), atimeMs: s.atimeMs || 0,
      birthtime: new Date(s.ctimeMs || 0), birthtimeMs: s.ctimeMs || 0,
      isFile: () => s.isFile,
      isDirectory: () => s.isDirectory,
      isSymbolicLink: () => s.isSymbolicLink || false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    };
  }
  function makeDirent(name, isFile, isDirectory, isSymbolicLink) {
    return {
      name,
      isFile: () => !!isFile,
      isDirectory: () => !!isDirectory,
      isSymbolicLink: () => !!isSymbolicLink,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    };
  }
  ctx.makeStat = makeStat;

  fs.existsSync = (p) => (isRemote(p) ? sExists(toRemote(p)) : O.existsSync.call(fs, p));
  fs.statSync = (p, opts) => (isRemote(p) ? makeStat(toRemote(p)) : O.statSync.call(fs, p, opts));
  fs.lstatSync = (p, opts) => (isRemote(p) ? makeStat(toRemote(p)) : O.lstatSync.call(fs, p, opts));
  fs.readFileSync = (p, opts) => {
    if (typeof p === "number" && _fdMap.has(p)) {
      const entry = _fdMap.get(p);
      const b = sRead(entry.path);
      const enc = typeof opts === "string" ? opts : opts && opts.encoding;
      return enc ? b.toString(enc) : b;
    }
    if (isRemote(p)) {
      const b = sRead(toRemote(p));
      const enc = typeof opts === "string" ? opts : opts && opts.encoding;
      return enc ? b.toString(enc) : b;
    }
    return O.readFileSync.call(fs, p, opts);
  };
  fs.writeFileSync = (p, d, opts) => {
    if (typeof p === "number" && _fdMap.has(p)) {
      const entry = _fdMap.get(p);
      if (entry.flags.includes("w") || entry.flags.includes("a") || entry.flags.includes("+")) {
        entry.chunks = [Buffer.isBuffer(d) ? d : Buffer.from(String(d))];
      }
      return;
    }
    if (isRemote(p)) {
      sWrite(toRemote(p), d);
      return;
    }
    return O.writeFileSync.call(fs, p, d, opts);
  };
  fs.readdirSync = (p, opts) => {
    if (!isRemote(p)) return O.readdirSync.call(fs, p, opts);
    const entries = sReaddir(toRemote(p));
    if (opts && opts.withFileTypes) {
      return entries.map((e) => {
        if (typeof e === "string") return makeDirent(e, true, false, false);
        return makeDirent(e.n, e.f, e.d, e.l);
      });
    }
    return entries.map((e) => (typeof e === "string" ? e : e.n));
  };
  fs.mkdirSync = (p, opts) => {
    if (isRemote(p)) {
      const rp = toRemote(p);
      const recursive = opts && (typeof opts === "object" ? opts.recursive : false);
      if (recursive) {
        sftpExec("mkdir -p " + JSON.stringify(rp));
      } else {
        sftpCall(OP.mkdir, rp);
      }
      cInv(rp);
      return;
    }
    return O.mkdirSync.call(fs, p, opts);
  };
  fs.accessSync = (p, mode) => {
    if (isRemote(p)) {
      if (!sExists(toRemote(p))) {
        const e = new Error("ENOENT: '" + toRemote(p) + "'");
        e.code = "ENOENT";
        throw e;
      }
      return;
    }
    return O.accessSync.call(fs, p, mode);
  };
  fs.unlinkSync = (p) => {
    if (isRemote(p)) {
      sftpCall(OP.unlink, toRemote(p));
      cInv(toRemote(p));
      return;
    }
    return O.unlinkSync.call(fs, p);
  };
  fs.renameSync = (o, n) => {
    if (isRemote(o)) {
      sftpCall(OP.rename, toRemote(o), null, toRemote(n));
      cInv(toRemote(o));
      cInv(toRemote(n));
      return;
    }
    return O.renameSync.call(fs, o, n);
  };
  fs.rmSync = (p, opts) => {
    if (isRemote(p)) {
      const rp = toRemote(p);
      const recursive = opts && opts.recursive;
      const st = sStat(p);
      if (st && st.isDirectory) {
        if (recursive) {
          sftpExec("rm -rf " + JSON.stringify(rp));
          cInvTree(rp);
        } else {
          sftpCall(OP.rmdir, rp);
          cInv(rp);
        }
      } else {
        sftpCall(OP.unlink, rp);
        cInv(rp);
      }
      return;
    }
    return O.rmSync.call(fs, p, opts);
  };
  fs.copyFileSync = (s, d, mode) => {
    const sRem = isRemote(s);
    const dRem = isRemote(d);
    const excl = mode && (mode & 1) === 1;
    if (sRem && dRem) {
      if (excl && sExists(toRemote(d))) throw eexist(d);
      sWrite(toRemote(d), sRead(toRemote(s)));
      return;
    }
    if (sRem && !dRem) {
      if (excl && O.existsSync.call(fs, d)) throw eexist(d);
      const dir = path.dirname(d);
      try {
        if (!O.existsSync.call(fs, dir)) O.mkdirSync.call(fs, dir, { recursive: true });
      } catch (e) {}
      O.writeFileSync.call(fs, d, sRead(toRemote(s)));
      return;
    }
    if (!sRem && dRem) {
      if (excl && sExists(toRemote(d))) throw eexist(d);
      sWrite(toRemote(d), O.readFileSync.call(fs, s));
      return;
    }
    return O.copyFileSync.call(fs, s, d, mode);
  };
  fs.appendFileSync = (p, d, opts) => {
    if (isRemote(p)) {
      const rp = toRemote(p);
      const ex = sExists(rp) ? sRead(rp) : Buffer.alloc(0);
      const nd = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
      sWrite(rp, Buffer.concat([ex, nd]));
      return;
    }
    return O.appendFileSync.call(fs, p, d, opts);
  };
  fs.realpathSync = (p, opts) => {
    if (isRemote(p)) return String(p).replace(/\\/g, "/");
    try {
      return O.realpathSync.call(fs, p, opts);
    } catch (e) {
      return String(p).replace(/\\/g, "/");
    }
  };
  Object.defineProperty(fs.realpathSync, "native", {
    value: fs.realpathSync,
    writable: false,
    configurable: false,
  });
  if (!O.readlinkSync) O.readlinkSync = fs.readlinkSync;
  fs.readlinkSync = (p, opts) => {
    if (isRemote(p)) {
      const rp = toRemote(p);
      // Use plain `readlink` (NOT `readlink -f`). The -f form follows symlinks and
      // returns a path for ANY existing file, never throwing — which breaks callers
      // (qoder's A_a/Mei) that use try-catch on readlinkSync to detect symlinks: with
      // -f the catch never fired, so regular files were misclassified as symlinks.
      // Plain readlink exits non-zero for non-symlinks AND non-existent paths; lstat
      // distinguishes them to match Node native semantics (EINVAL vs ENOENT).
      const r = sftpExec("readlink " + JSON.stringify(rp));
      if (r.exitCode !== 0) {
        let code = "EINVAL", errno = -22;
        try {
          sftpCall(OP.lstat, rp);
        } catch (le) {
          if (le && le.code === "ENOENT") { code = "ENOENT"; errno = -2; }
        }
        const err = new Error(code + ": " + (code === "ENOENT" ? "no such file or directory" : "invalid argument") + ", readlink '" + p + "'");
        err.code = code;
        err.errno = errno;
        throw err;
      }
      return r.stdout.toString("utf8").trim();
    }
    return O.readlinkSync.call(fs, p, opts);
  };
  if (!O.symlinkSync) O.symlinkSync = fs.symlinkSync;
  fs.symlinkSync = (target, p) => {
    if (isRemote(p) || isRemote(target)) {
      sftpExec("ln -sf " + JSON.stringify(toRemote(target)) + " " + JSON.stringify(toRemote(p)));
      return;
    }
    return O.symlinkSync.call(fs, target, p);
  };
  fs.rmdirSync = (p, opts) => {
    if (isRemote(p)) {
      sftpCall(OP.rmdir, toRemote(p));
      cInv(toRemote(p));
      return;
    }
    return O.rmdirSync.call(fs, p, opts);
  };

  const _fdMap = new Map();
  let _nextFd = 1000;
  if (!O.openSync) O.openSync = fs.openSync;
  fs.openSync = function (p, flags, mode) {
    if (isRemote(p)) {
      const fd = _nextFd++;
      _fdMap.set(fd, { path: toRemote(p), flags: String(flags || ""), chunks: [], mode: null });
      return fd;
    }
    return O.openSync.apply(fs, arguments);
  };
  if (!O.writeSync) O.writeSync = fs.writeSync;
  fs.writeSync = function (fd, data, off, len, pos) {
    const entry = _fdMap.get(fd);
    if (entry) {
      entry.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
      return Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
    }
    return O.writeSync.apply(fs, arguments);
  };
  if (!O.closeSync) O.closeSync = fs.closeSync;
  fs.closeSync = function (fd) {
    const entry = _fdMap.get(fd);
    if (entry) {
      _fdMap.delete(fd);
      if (entry.flags.includes("w") || entry.flags.includes("a") || entry.flags.includes("+")) {
        sWrite(entry.path, Buffer.concat(entry.chunks));
        if (entry.mode != null) {
          const oct = "0" + (entry.mode >>> 0).toString(8);
          try { sftpExec("chmod " + oct + " " + JSON.stringify(entry.path)); } catch (e) {}
        }
      }
      return;
    }
    return O.closeSync.apply(fs, arguments);
  };
  if (!O.readSync) O.readSync = fs.readSync;
  fs.readSync = function (fd, buf, off, len, pos) {
    const entry = _fdMap.get(fd);
    if (entry) {
      const d = sRead(entry.path);
      d.copy(buf, off || 0, pos || 0, (pos || 0) + (len || d.length));
      return Math.min(len || d.length, d.length - (pos || 0));
    }
    return O.readSync.apply(fs, arguments);
  };
  // fd-based ops that receive virtual fds from openSync. fsync/fdatasync have no
  // remote SFTP equivalent — buffered chunks flush on closeSync — so no-op for
  // virtual fds. fstatSync returns a stat for the entry's remote path; ftruncateSync
  // adjusts the in-memory chunk buffer. isVirtualFd is shared with async-ops.
  const _oFsyncSync = fs.fsyncSync;
  const _oFdatasyncSync = fs.fdatasyncSync;
  const _oFstatSync = fs.fstatSync;
  const _oFtruncateSync = fs.ftruncateSync;
  ctx.isVirtualFd = (fd) => typeof fd === "number" && _fdMap.has(fd);
  fs.fsyncSync = function (fd) {
    if (ctx.isVirtualFd(fd)) return;
    return _oFsyncSync.apply(fs, arguments);
  };
  if (_oFdatasyncSync) {
    fs.fdatasyncSync = function (fd) {
      if (ctx.isVirtualFd(fd)) return;
      return _oFdatasyncSync.apply(fs, arguments);
    };
  }
  fs.fstatSync = function (fd, opts) {
    if (ctx.isVirtualFd(fd)) return makeStat(_fdMap.get(fd).path);
    return _oFstatSync.apply(fs, arguments);
  };
  fs.ftruncateSync = function (fd, len) {
    if (ctx.isVirtualFd(fd)) {
      const entry = _fdMap.get(fd);
      const n = len || 0;
      const cur = Buffer.concat(entry.chunks);
      if (n === 0) entry.chunks = [];
      else if (n < cur.length) entry.chunks = [cur.subarray(0, n)];
      else if (n > cur.length) entry.chunks = [Buffer.concat([cur, Buffer.alloc(n - cur.length)])];
      return;
    }
    return _oFtruncateSync.apply(fs, arguments);
  };
  // graceful-fs (qoder's fs layer) wraps openSync to set file mode via fchmodSync(fd, mode)
  // immediately after open. The file content doesn't exist remotely until closeSync flushes
  // the buffered chunks, so we can't chmod the path yet — store mode on the entry and apply
  // it in closeSync after sWrite. fchown/futimes have no remote fd equivalent; no-op.
  const _oFchmodSync = fs.fchmodSync;
  const _oFchownSync = fs.fchownSync;
  const _oFutimesSync = fs.futimesSync;
  fs.fchmodSync = function (fd, mode) {
    if (ctx.isVirtualFd(fd)) { _fdMap.get(fd).mode = mode; return; }
    return _oFchmodSync.apply(fs, arguments);
  };
  if (_oFchownSync) {
    fs.fchownSync = function (fd, uid, gid) {
      if (ctx.isVirtualFd(fd)) return;
      return _oFchownSync.apply(fs, arguments);
    };
  }
  if (_oFutimesSync) {
    fs.futimesSync = function (fd, atime, mtime) {
      if (ctx.isVirtualFd(fd)) return;
      return _oFutimesSync.apply(fs, arguments);
    };
  }
  // utimesSync / chmodSync / chownSync — lockfile (proper-lockfile) uses utimesSync to probe
  // filesystem mtime precision on the lockfile path. Without a patch, the native call receives
  // the virtual-prefixed path and Node's win32 realpath internals hybridize it (C:\◦…\root).
  // Route remote paths through sftp exec; local paths pass through unchanged.
  function _fmtTime(t) {
    if (typeof t === "number") {
      const d = new Date(t);
      return d.toISOString().replace(/\.\d+Z$/, "Z");
    }
    if (t instanceof Date) return t.toISOString().replace(/\.\d+Z$/, "Z");
    return String(t);
  }
  if (!O.utimesSync) O.utimesSync = fs.utimesSync;
  fs.utimesSync = function (p, atime, mtime) {
    if (isRemote(p)) {
      const rp = toRemote(p);
      try { sftpExec("touch -a -m -d " + JSON.stringify(_fmtTime(mtime)) + " " + JSON.stringify(rp)); } catch (e) {}
      return;
    }
    return O.utimesSync.apply(fs, arguments);
  };
  if (O.lutimesSync) {
    if (!O.lutimesSync) O.lutimesSync = fs.lutimesSync;
    const _oLutimesSync = O.lutimesSync;
    fs.lutimesSync = function (p, atime, mtime) {
      if (isRemote(p)) {
        const rp = toRemote(p);
        try { sftpExec("touch -a -m -d " + JSON.stringify(_fmtTime(mtime)) + " " + JSON.stringify(rp)); } catch (e) {}
        return;
      }
      return _oLutimesSync.apply(fs, arguments);
    };
  }
  if (!O.chmodSync) O.chmodSync = fs.chmodSync;
  fs.chmodSync = function (p, mode) {
    if (isRemote(p)) {
      const rp = toRemote(p);
      const oct = "0" + (mode >>> 0).toString(8);
      try { sftpExec("chmod " + oct + " " + JSON.stringify(rp)); } catch (e) {}
      return;
    }
    return O.chmodSync.apply(fs, arguments);
  };

  const _locked = {};
  const lockMethod = (name) => {
    _locked[name] = fs[name];
    try {
      Object.defineProperty(fs, name, {
        get: () => _locked[name],
        // Allow controlled outer wrapping (e.g. qoder-local-fs .qoder→mirror rewrite, installed
        // after the bridge) while still blocking delete + property redefinition (configurable:
        // false). qoder itself does not reassign sync fs methods, so this is safe.
        set: (v) => { _locked[name] = v; },
        configurable: false,
        enumerable: true,
      });
    } catch (e) {}
  };
  for (const name of [
    "existsSync", "statSync", "lstatSync", "readFileSync", "writeFileSync",
    "readdirSync", "mkdirSync", "unlinkSync", "accessSync", "renameSync",
    "rmSync", "copyFileSync", "appendFileSync", "realpathSync", "rmdirSync",
    "createReadStream", "createWriteStream", "openSync", "writeSync", "closeSync", "readSync",
    "readlinkSync", "symlinkSync", "utimesSync", "chmodSync",
    "fsyncSync", "fdatasyncSync", "fstatSync", "ftruncateSync",
    "fchmodSync", "fchownSync", "futimesSync",
  ]) {
    lockMethod(name);
  }
}

module.exports = { install };
