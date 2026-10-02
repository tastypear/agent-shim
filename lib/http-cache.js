"use strict";

// Consumer-side cache for HTTP mode — mirrors fs-bridge/cache.js patterns.
// Sits above remote-fs-node's binding-level patch: wraps JS-level fs methods
// with a 60s TTL in-memory cache, and makes realpathSync a string transform
// for remote paths (matching SSH mode's fs-bridge/sync-ops.js:181-188).

const fs = require("fs");
const path = require("path");

// Save pre-install write/read for cache file I/O — avoids triggering _cClear
// from our own mutator wrappers when writing the cache file.
const _realWriteFile = fs.writeFileSync;
const _realReadFile = fs.readFileSync;

const TTL = 60000; // 60s — same as fs-bridge/cache.js:8
const _cache = new Map();

function _cGet(type, p) {
  const e = _cache.get(type + ":" + p);
  if (e && Date.now() - e.t < TTL) return e.v;
  return undefined;
}

function _cSet(type, p, v) {
  _cache.set(type + ":" + p, { v, t: Date.now() });
}

function _cClear() {
  _cache.clear();
}

// ─── install: wrap fs methods with consumer cache ───────────────────────
function install(fsObj, isRemote) {
  const _existsSync = fsObj.existsSync;
  const _statSync = fsObj.statSync;
  const _lstatSync = fsObj.lstatSync;
  const _realpathSync = fsObj.realpathSync;
  const _readdirSync = fsObj.readdirSync;

  function _norm(p) {
    return Buffer.isBuffer(p) ? p.toString("utf8") : String(p).replace(/\\/g, "/");
  }

  // existsSync: cache true/false (including false for 404)
  fsObj.existsSync = function (p) {
    const np = _norm(p);
    if (!isRemote(np)) return _existsSync.call(fsObj, p);
    const cached = _cGet("exists", np);
    if (cached !== undefined) return cached;
    const result = _existsSync.call(fsObj, p);
    _cSet("exists", np, result);
    return result;
  };

  // statSync: cache Stats or ENOENT error
  fsObj.statSync = function (p, options) {
    const np = _norm(p);
    if (!isRemote(np)) return _statSync.call(fsObj, p, options);
    const cached = _cGet("stat", np);
    if (cached !== undefined) {
      if (cached instanceof Error) throw cached;
      return cached;
    }
    try {
      const result = _statSync.call(fsObj, p, options);
      _cSet("stat", np, result);
      return result;
    } catch (err) {
      if (err.code === "ENOENT") _cSet("stat", np, err);
      throw err;
    }
  };

  // lstatSync: same pattern, separate cache namespace
  fsObj.lstatSync = function (p, options) {
    const np = _norm(p);
    if (!isRemote(np)) return _lstatSync.call(fsObj, p, options);
    const cached = _cGet("lstat", np);
    if (cached !== undefined) {
      if (cached instanceof Error) throw cached;
      return cached;
    }
    try {
      const result = _lstatSync.call(fsObj, p, options);
      _cSet("lstat", np, result);
      return result;
    } catch (err) {
      if (err.code === "ENOENT") _cSet("lstat", np, err);
      throw err;
    }
  };

  // ── readFileSync: cache small file reads (incl. ENOENT) ─────────────────
  const _readFileSync = fsObj.readFileSync;
  const READ_CACHE_MAX = 262144; // 256KB
  function _cacheableRead(result) {
    return (Buffer.isBuffer(result) && result.length <= READ_CACHE_MAX) ||
           (typeof result === "string" && result.length <= READ_CACHE_MAX);
  }
  fsObj.readFileSync = function (p, options) {
    const np = _norm(p);
    if (!isRemote(np)) return _readFileSync.call(fsObj, p, options);
    const cached = _cGet("read", np);
    if (cached !== undefined) {
      if (cached instanceof Error) throw cached;
      return cached;
    }
    try {
      const result = _readFileSync.call(fsObj, p, options);
      if (_cacheableRead(result)) _cSet("read", np, result);
      return result;
    } catch (err) {
      if (err.code === "ENOENT") _cSet("read", np, err);
      throw err;
    }
  };

  // ── readdirSync: cache directory listings (incl. ENOENT) ───────────────
  fsObj.readdirSync = function (p, options) {
    const np = _norm(p);
    if (!isRemote(np)) return _readdirSync.call(fsObj, p, options);
    const cached = _cGet("readdir", np);
    if (cached !== undefined) {
      if (cached instanceof Error) throw cached;
      return cached;
    }
    try {
      const result = _readdirSync.call(fsObj, p, options);
      _cSet("readdir", np, result);
      return result;
    } catch (err) {
      if (err.code === "ENOENT") _cSet("readdir", np, err);
      throw err;
    }
  };

  // ── async fs.stat / fs.lstat (callback) — same cache as sync ───────────
  const _stat = fsObj.stat;
  fsObj.stat = function (p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    if (!cb) return fsObj.statSync(p, opts);
    const np = _norm(p);
    if (!isRemote(np)) return _stat.call(fsObj, p, opts, cb);
    const cached = _cGet("stat", np);
    if (cached !== undefined) {
      process.nextTick(() => cb(cached instanceof Error ? cached : null, cached instanceof Error ? undefined : cached));
      return;
    }
    _stat.call(fsObj, p, opts, function (err, result) {
      if (err) { if (err.code === "ENOENT") _cSet("stat", np, err); }
      else _cSet("stat", np, result);
      cb(err, result);
    });
  };

  const _lstat = fsObj.lstat;
  fsObj.lstat = function (p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    if (!cb) return fsObj.lstatSync(p, opts);
    const np = _norm(p);
    if (!isRemote(np)) return _lstat.call(fsObj, p, opts, cb);
    const cached = _cGet("lstat", np);
    if (cached !== undefined) {
      process.nextTick(() => cb(cached instanceof Error ? cached : null, cached instanceof Error ? undefined : cached));
      return;
    }
    _lstat.call(fsObj, p, opts, function (err, result) {
      if (err) { if (err.code === "ENOENT") _cSet("lstat", np, err); }
      else _cSet("lstat", np, result);
      cb(err, result);
    });
  };

  // ── async fs.exists (deprecated, no error param) ────────────────────────
  const _exists = fsObj.exists;
  fsObj.exists = function (p, cb) {
    const np = _norm(p);
    if (!isRemote(np)) return _exists.call(fsObj, p, cb);
    const cached = _cGet("exists", np);
    if (cached !== undefined) { process.nextTick(() => cb(cached)); return; }
    _exists.call(fsObj, p, function (result) { _cSet("exists", np, result); cb(result); });
  };

  // ── async fs.access — cache success/ENOENT ──────────────────────────────
  const _access = fsObj.access;
  fsObj.access = function (p, mode, cb) {
    if (typeof mode === "function") { cb = mode; mode = undefined; }
    const np = _norm(p);
    if (!isRemote(np)) return _access.call(fsObj, p, mode, cb);
    const cached = _cGet("access", np);
    if (cached !== undefined) {
      process.nextTick(() => cb(cached instanceof Error ? cached : null));
      return;
    }
    _access.call(fsObj, p, mode, function (err) {
      if (err) { if (err.code === "ENOENT") _cSet("access", np, err); }
      else _cSet("access", np, null);
      cb(err);
    });
  };

  // ── async fs.readFile — cache small files ──────────────────────────────
  const _readFile = fsObj.readFile;
  fsObj.readFile = function (p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    const np = _norm(p);
    if (!isRemote(np)) return _readFile.call(fsObj, p, opts, cb);
    const cached = _cGet("read", np);
    if (cached !== undefined) {
      process.nextTick(() => cb(cached instanceof Error ? cached : null, cached instanceof Error ? undefined : cached));
      return;
    }
    _readFile.call(fsObj, p, opts, function (err, result) {
      if (!err && _cacheableRead(result)) _cSet("read", np, result);
      else if (err && err.code === "ENOENT") _cSet("read", np, err);
      cb(err, result);
    });
  };

  // ── async fs.readdir — cache directory listings ────────────────────────
  const _readdir = fsObj.readdir;
  fsObj.readdir = function (p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    const np = _norm(p);
    if (!isRemote(np)) return _readdir.call(fsObj, p, opts, cb);
    const cached = _cGet("readdir", np);
    if (cached !== undefined) {
      process.nextTick(() => cb(cached instanceof Error ? cached : null, cached instanceof Error ? undefined : cached));
      return;
    }
    _readdir.call(fsObj, p, opts, function (err, result) {
      if (err) { if (err.code === "ENOENT") _cSet("readdir", np, err); }
      else _cSet("readdir", np, result);
      cb(err, result);
    });
  };

  // realpathSync: string transform for remote paths — no server call.
  // Matches SSH mode fs-bridge/sync-ops.js:181-188.
  fsObj.realpathSync = function (p, opts) {
    const np = _norm(p);
    if (isRemote(np)) return np;
    try {
      return _realpathSync.call(fsObj, p, opts);
    } catch (e) {
      return np;
    }
  };
  try {
    Object.defineProperty(fsObj.realpathSync, "native", {
      value: fsObj.realpathSync,
      writable: false,
      configurable: false,
    });
  } catch (_) {}

  // fs.realpath (async callback): delegate to realpathSync for remote paths.
  // Matches SSH mode fs-bridge/async-ops.js:78.
  const _realpath = fsObj.realpath;
  fsObj.realpath = function (p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    const np = _norm(p);
    if (isRemote(np)) {
      if (cb) process.nextTick(() => cb(null, np));
      return;
    }
    return _realpath.call(fsObj, p, opts, cb);
  };
  try {
    Object.defineProperty(fsObj.realpath, "native", {
      value: fsObj.realpath,
      writable: false,
      configurable: false,
    });
  } catch (_) {}

  // promises.realpath: delegate to sync (matches fs-bridge/promises.js:144)
  if (fsObj.promises && typeof fsObj.promises.realpath === "function") {
    fsObj.promises.realpath = function (p, opts) {
      return Promise.resolve(fsObj.realpathSync(p, opts));
    };
  }

  // ── fs.promises.stat / lstat / readFile / access — same cache ──────────
  if (fsObj.promises) {
    const _pStat = fsObj.promises.stat;
    if (typeof _pStat === "function") {
      fsObj.promises.stat = function (p, opts) {
        const np = _norm(p);
        if (!isRemote(np)) return _pStat.call(fsObj.promises, p, opts);
        const cached = _cGet("stat", np);
        if (cached !== undefined) return cached instanceof Error ? Promise.reject(cached) : Promise.resolve(cached);
        return _pStat.call(fsObj.promises, p, opts).then(r => { _cSet("stat", np, r); return r; })
          .catch(e => { if (e.code === "ENOENT") _cSet("stat", np, e); throw e; });
      };
    }
    const _pLstat = fsObj.promises.lstat;
    if (typeof _pLstat === "function") {
      fsObj.promises.lstat = function (p, opts) {
        const np = _norm(p);
        if (!isRemote(np)) return _pLstat.call(fsObj.promises, p, opts);
        const cached = _cGet("lstat", np);
        if (cached !== undefined) return cached instanceof Error ? Promise.reject(cached) : Promise.resolve(cached);
        return _pLstat.call(fsObj.promises, p, opts).then(r => { _cSet("lstat", np, r); return r; })
          .catch(e => { if (e.code === "ENOENT") _cSet("lstat", np, e); throw e; });
      };
    }
    const _pReadFile = fsObj.promises.readFile;
    if (typeof _pReadFile === "function") {
      fsObj.promises.readFile = function (p, opts) {
        const np = _norm(p);
        if (!isRemote(np)) return _pReadFile.call(fsObj.promises, p, opts);
        const cached = _cGet("read", np);
        if (cached !== undefined) return cached instanceof Error ? Promise.reject(cached) : Promise.resolve(cached);
        return _pReadFile.call(fsObj.promises, p, opts).then(r => { if (_cacheableRead(r)) _cSet("read", np, r); return r; })
          .catch(e => { if (e.code === "ENOENT") _cSet("read", np, e); throw e; });
      };
    }
    const _pAccess = fsObj.promises.access;
    if (typeof _pAccess === "function") {
      fsObj.promises.access = function (p, mode) {
        const np = _norm(p);
        if (!isRemote(np)) return _pAccess.call(fsObj.promises, p, mode);
        const cached = _cGet("access", np);
        if (cached !== undefined) return cached instanceof Error ? Promise.reject(cached) : Promise.resolve();
        return _pAccess.call(fsObj.promises, p, mode).then(() => { _cSet("access", np, null); })
          .catch(e => { if (e.code === "ENOENT") _cSet("access", np, e); throw e; });
      };
    }
    const _pReaddir = fsObj.promises.readdir;
    if (typeof _pReaddir === "function") {
      fsObj.promises.readdir = function (p, opts) {
        const np = _norm(p);
        if (!isRemote(np)) return _pReaddir.call(fsObj.promises, p, opts);
        const cached = _cGet("readdir", np);
        if (cached !== undefined) return cached instanceof Error ? Promise.reject(cached) : Promise.resolve(cached);
        return _pReaddir.call(fsObj.promises, p, opts).then(r => { _cSet("readdir", np, r); return r; })
          .catch(e => { if (e.code === "ENOENT") _cSet("readdir", np, e); throw e; });
      };
    }
  }

  // Override binding-level realpath — Node.js internals (fs.promises.readFile,
  // module resolution) call process.binding('fs').realpath directly, bypassing
  // all JS-level wrappers. remote-fs-node's binding.js exports _impl, so we
  // replace realpath to return the path as-is (matching SSH mode behavior).
  try {
    const bindingMod = require("remote-fs-node/lib/binding");
    if (bindingMod._impl && bindingMod._impl.realpath) {
      bindingMod._impl.realpath = async function (args) { return args[0]; };
    }
  } catch (_) {}

  // Cache invalidation on mutations — wrap key mutating methods (sync + async).
  const _mutators = [
    "writeFileSync", "mkdirSync", "rmSync", "rmdirSync", "unlinkSync",
    "renameSync", "copyFileSync", "appendFileSync", "truncateSync",
    "chmodSync", "chownSync", "utimesSync", "symlinkSync",
    "writeFile", "mkdir", "rm", "rmdir", "unlink",
    "rename", "copyFile", "appendFile", "truncate",
    "chmod", "chown", "utimes", "symlink",
  ];
  for (const m of _mutators) {
    const orig = fsObj[m];
    if (typeof orig !== "function") continue;
    fsObj[m] = function (...args) {
      _cClear();
      return orig.apply(fsObj, args);
    };
  }
  // promises mutators
  if (fsObj.promises) {
    const _pMutators = [
      "writeFile", "mkdir", "rm", "rmdir", "unlink", "rename",
      "copyFile", "appendFile", "chmod", "chown", "utimes", "symlink",
    ];
    for (const m of _pMutators) {
      const orig = fsObj.promises[m];
      if (typeof orig !== "function") continue;
      fsObj.promises[m] = function (...args) {
        _cClear();
        return orig.apply(fsObj.promises, args);
      };
    }
  }
}

// ─── Probe writeback ────────────────────────────────────────────────────
function writeProbeCache(cfg, probes) {
  if (!cfg || !cfg.cacheFile || !probes) return;
  try {
    let diskCache = {};
    try {
      diskCache = JSON.parse(_realReadFile.call(fs, cfg.cacheFile, "utf8"));
    } catch (_) {}
    let dirty = false;
    if (probes.home && diskCache.home !== probes.home) { diskCache.home = probes.home; dirty = true; }
    if (probes.osRelease && diskCache.uname !== probes.osRelease) { diskCache.uname = probes.osRelease; dirty = true; }
    if (probes.nodeVersion && diskCache.nodeVersion !== probes.nodeVersion) { diskCache.nodeVersion = probes.nodeVersion; dirty = true; }
    if (probes.arch && diskCache.arch !== probes.arch) { diskCache.arch = probes.arch; dirty = true; }
    if (dirty) {
      diskCache.host = cfg.host;
      _realWriteFile.call(fs, cfg.cacheFile, JSON.stringify(diskCache, null, 2));
    }
  } catch (_) {}
}

// ─── Startup batching ───────────────────────────────────────────────────
// Batch exists + stat for all adapter prefetch paths via two exec calls
// (one `test -e` batch, one `stat -c` batch). Results injected into the
// consumer cache so subsequent existsSync/statSync calls hit cache.
// Mirrors fs-bridge/cache.js prefetchStartupExists + prefetchStartupStat.
function prefetchStartup(exec, cfg, adapter, getRemoteCwd) {
  if (!adapter || !adapter.getPrefetchPaths || !exec || !exec.sftpExec) return;
  try {
    const cwd = getRemoteCwd();
    const parent = cwd.replace(/\/[^/]+$/, "") || "/";
    const pf = adapter.getPrefetchPaths(cwd, parent);
    if (!pf) return;
    let n = 0;

    // ── exists batch: one `test -e` per path, tagged output ──
    if (pf.exists && pf.exists.length) {
      const tests = pf.exists
        .map((p) => "if test -e " + JSON.stringify(p) + "; then printf '" + p + "\\t1\\n'; else printf '" + p + "\\t0\\n'; fi")
        .join(";");
      try {
        const r = exec.sftpExec(tests);
        for (const line of r.stdout.toString("utf8").split("\n")) {
          const m = line.split("\t");
          if (m.length === 2) { _cSet("exists", m[0], m[1] === "1"); n++; }
        }
      } catch (_) {}
    }

    // ── stat batch: one `stat -c` for all paths, build real Stats objects ──
    if (pf.stat && pf.stat.length) {
      try {
        const { Stats } = require("remote-fs-node/lib/stats");
        const args = pf.stat.map((p) => JSON.stringify(p)).join(" ");
        const cmd = "stat -c '%n|%F|%s|%Y|%X|%Z|%a|%u|%g' " + args + " 2>/dev/null";
        const r = exec.sftpExec(cmd);
        const out = r.stdout.toString("utf8").trim();
        if (out) {
          const typeMap = { "regular file": "file", "directory": "dir", "symbolic link": "symlink" };
          for (const line of out.split("\n")) {
            const f = line.split("|");
            if (f.length < 9) continue;
            const [name, type, size, mtime, atime, ctime, perm, uid, gid] = f;
            _cSet("stat", name, new Stats({
              type: typeMap[type] || "file",
              size: parseInt(size, 10) || 0,
              mode: perm,
              mtime: parseFloat(mtime) * 1000 || 0,
              atime: parseFloat(atime) * 1000 || 0,
              ctime: parseFloat(ctime) * 1000 || 0,
              uid: parseInt(uid, 10) || 0,
              gid: parseInt(gid, 10) || 0,
            }));
            n++;
          }
        }
      } catch (_) { /* stat -c unavailable — per-path statSync fetches individually */ }
    }

    return n;
  } catch (_) {
    return 0;
  }
}

// ─── Async refresh ──────────────────────────────────────────────────────
// Background refresh of probe values for next startup (non-blocking).
function refreshProbesAsync(exec, cfg, adapter, probes) {
  if (!exec || !exec.sftpExecAsync || !cfg || !cfg.cacheFile) return Promise.resolve();
  return _doRefresh(exec, cfg, adapter).catch(() => {});
}

async function _doRefresh(exec, cfg, adapter) {
  let diskCache = {};
  try {
    diskCache = JSON.parse(_realReadFile.call(fs, cfg.cacheFile, "utf8"));
  } catch (_) {}
  diskCache.host = cfg.host;
  if (!diskCache.exists) diskCache.exists = {};
  if (!diskCache.read) diskCache.read = {};

  const promises = [
    exec.sftpExecAsync("echo $HOME").then((r) => {
      const h = r.stdout.toString("utf8").trim();
      if (h) diskCache.home = h;
    }).catch(() => {}),
    exec.sftpExecAsync("node --version").then((r) => {
      const v = r.stdout.toString("utf8").trim();
      if (/^v\d+\.\d+\.\d+/.test(v)) diskCache.nodeVersion = v;
    }).catch(() => {}),
    exec.sftpExecAsync("uname -m").then((r) => {
      const a = _mapArch(r.stdout.toString("utf8"));
      if (a) diskCache.arch = a;
    }).catch(() => {}),
  ];
  if (adapter && adapter.needsOsReleaseFake && adapter.needsOsReleaseFake()) {
    promises.push(
      exec.sftpExecAsync("uname -r").then((r) => {
        const v = r.stdout.toString("utf8").trim();
        if (v) diskCache.uname = v;
      }).catch(() => {})
    );
  }
  await Promise.all(promises);
  try {
    _realWriteFile.call(fs, cfg.cacheFile, JSON.stringify(diskCache, null, 2));
  } catch (_) {}
}

function _mapArch(m) {
  const s = String(m).trim();
  if (/^x86_64$|^amd64$/i.test(s)) return "x64";
  if (/^aarch64$|^arm64$/i.test(s)) return "arm64";
  if (/^armv[0-9].*|^arm$/i.test(s)) return "arm";
  if (/^i[3-6]86$|^x86$/i.test(s)) return "ia32";
  if (/^ppc64/i.test(s)) return "ppc64";
  if (/^s390x$/i.test(s)) return "s390x";
  return null;
}

module.exports = { install, writeProbeCache, prefetchStartup, refreshProbesAsync };