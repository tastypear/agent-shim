const Module = require("module");

function install(ctx) {
  const { fs, isRemote, toRemote, sftpExec, sRead, sWrite, sExists, cInv, makeStat } = ctx;

  const _nativePopen = fs.promises.open;

  function makeRemoteFileHandle(rp, flags) {
    const _isWrite = flags.includes("w") || flags.includes("a") || flags.includes("+");
    let _chunks = [];
    let _closed = false;
    const _chk = () => {
      if (_closed) {
        const e = new Error("FileHandle is closed");
        e.code = "EBADF";
        throw e;
      }
    };
    return {
      fd: -1,
      async writeFile(data, opts) {
        _chk();
        const enc = typeof opts === "string" ? opts : opts && opts.encoding;
        _chunks = [Buffer.isBuffer(data) ? data : Buffer.from(String(data), enc || "utf8")];
      },
      async readFile(opts) {
        _chk();
        const b = sRead(rp);
        const enc = typeof opts === "string" ? opts : opts && opts.encoding;
        return enc ? b.toString(enc) : b;
      },
      async write(buf, offset, length, position) {
        _chk();
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
        const off = typeof offset === "number" ? offset : 0;
        const len = typeof length === "number" ? length : b.length - off;
        _chunks.push(b.subarray(off, off + len));
        return { bytesWritten: len, buffer: b };
      },
      async read(buf, offset, length, position) {
        _chk();
        const full = sRead(rp);
        const pos = typeof position === "number" ? position : 0;
        const off = typeof offset === "number" ? offset : 0;
        const len = typeof length === "number" ? length : full.length - pos;
        const n = Math.max(0, Math.min(len, full.length - pos));
        if (n > 0) full.copy(buf, off, pos, pos + n);
        return { bytesRead: n, buffer: buf };
      },
      async stat() { _chk(); return makeStat(rp); },
      async chmod(mode) {
        _chk();
        const oct = "0" + (mode >>> 0).toString(8);
        sftpExec("chmod " + oct + " " + JSON.stringify(rp));
      },
      async sync() { _chk(); },
      async appendFile(data, opts) {
        _chk();
        const enc = typeof opts === "string" ? opts : opts && opts.encoding;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), enc || "utf8");
        const existing = sExists(rp) ? sRead(rp) : Buffer.alloc(0);
        _chunks = [Buffer.concat([existing, buf])];
      },
      async close() {
        if (_closed) return;
        _closed = true;
        if (_isWrite && _chunks.length > 0) {
          sWrite(rp, Buffer.concat(_chunks));
          cInv(rp);
        }
        _chunks = [];
      },
      async truncate(len) {
        _chk();
        if (_isWrite) {
          const full = _chunks.length > 0 ? Buffer.concat(_chunks) : sRead(rp);
          _chunks = [full.subarray(0, typeof len === "number" ? len : 0)];
        } else {
          const full = sRead(rp);
          _chunks = [full.subarray(0, typeof len === "number" ? len : 0)];
        }
      },
      async fdatasync() { _chk(); },
      async fchmod(mode) {
        _chk();
        const oct = "0" + (mode >>> 0).toString(8);
        sftpExec("chmod " + oct + " " + JSON.stringify(rp));
      },
      async fstat() { _chk(); return makeStat(rp); },
      async ftruncate(len) {
        _chk();
        const full = sRead(rp);
        _chunks = [full.subarray(0, typeof len === "number" ? len : 0)];
      },
    };
  }

  const P = {};
  P.open = function (p, flags, mode) {
    if (isRemote(p)) {
      return new Promise((res, rej) => {
        try {
          const fl = String(flags || "");
          if (fl.includes("x") && sExists(toRemote(p))) {
            const e = new Error("EEXIST: file already exists, open '" + toRemote(p) + "'");
            e.code = "EEXIST";
            return rej(e);
          }
          res(makeRemoteFileHandle(toRemote(p), fl));
        } catch (e) {
          rej(e);
        }
      });
    }
    return _nativePopen(p, flags, mode);
  };
  P.readFile = (p, o) => new Promise((res, rej) => { try { res(fs.readFileSync(p, o)); } catch (e) { rej(e); } });
  P.writeFile = (p, d, o) => new Promise((res, rej) => { try { fs.writeFileSync(p, d, o); res(); } catch (e) { rej(e); } });
  P.stat = (p) => new Promise((res, rej) => { try { res(fs.statSync(p)); } catch (e) { rej(e); } });
  P.access = (p, m) => new Promise((res, rej) => { try { fs.accessSync(p, m); res(); } catch (e) { rej(e); } });
  P.mkdir = (p, o) => new Promise((res, rej) => { try { fs.mkdirSync(p, o); res(); } catch (e) { rej(e); } });
  P.unlink = (p) => new Promise((res, rej) => { try { fs.unlinkSync(p); res(); } catch (e) { rej(e); } });
  P.rename = (o, n) => new Promise((res, rej) => { try { fs.renameSync(o, n); res(); } catch (e) { rej(e); } });
  P.lstat = (p) => new Promise((res, rej) => { try { res(fs.lstatSync(p)); } catch (e) { rej(e); } });
  P.chmod = (p, mode) => new Promise((res, rej) => {
    try {
      if (isRemote(p)) {
        const rp = toRemote(p);
        const oct = "0" + (mode >>> 0).toString(8);
        sftpExec("chmod " + oct + " " + JSON.stringify(rp));
      } else {
        fs.chmodSync(p, mode);
      }
      res();
    } catch (e) {
      rej(e);
    }
  });
  P.copyFile = (s, d, m) => new Promise((res, rej) => { try { fs.copyFileSync(s, d, m); res(); } catch (e) { rej(e); } });
  P.appendFile = (p, d, o) => new Promise((res, rej) => { try { fs.appendFileSync(p, d, o); res(); } catch (e) { rej(e); } });
  P.rm = (p, o) => new Promise((res, rej) => { try { fs.rmSync(p, o); res(); } catch (e) { rej(e); } });
  P.realpath = (p, opts) => new Promise((res, rej) => { try { res(fs.realpathSync(p, opts)); } catch (e) { rej(e); } });
  P.readlink = (p, opts) => new Promise((res, rej) => { try { res(fs.readlinkSync(p, opts)); } catch (e) { rej(e); } });
  P.symlink = (target, p) => new Promise((res, rej) => { try { fs.symlinkSync(target, p); res(); } catch (e) { rej(e); } });
  P.readdir = (p, opts) => new Promise((res, rej) => {
    try { res(fs.readdirSync(p, opts)); } catch (e) {
      const patterns = ctx.adapter.getSwallowEnoentPatterns();
      if (e.code === "ENOENT" && patterns.some((re) => re.test(String(p || "")))) {
        res([]);
        return;
      }
      rej(e);
    }
  });

  try {
    const orig = fs.promises;
    for (const k of Object.getOwnPropertyNames(orig)) {
      if (!(k in P)) {
        try { P[k] = orig[k]; } catch (e) {}
      }
    }
  } catch (e) {}

  let realFsp = P;
  try {
    realFsp = Module._load.call(Module, "fs/promises");
    for (const k of Object.keys(P)) {
      if (typeof P[k] === "function") {
        try { realFsp[k] = P[k]; } catch (e) {}
      }
    }
  } catch (e) {
    require("../logger").child("fs").warn("fsp in-place mutate failed: " + e.message);
  }
  try {
    Object.defineProperty(fs, "promises", { value: realFsp, configurable: true, writable: true });
  } catch (e) {}
  global.__REMOTE_PROMISES__ = realFsp;

  try {
    Object.defineProperty(fs, "promises", {
      get: () => realFsp,
      set: () => {},
      configurable: false,
      enumerable: true,
    });
  } catch (e) {}
  for (const k of Object.keys(P)) {
    if (typeof P[k] === "function") {
      try {
        Object.defineProperty(realFsp, k, {
          get: () => P[k],
          set: () => {},
          configurable: false,
          enumerable: true,
        });
      } catch (e) {}
    }
  }
}

module.exports = { install };
