"use strict";

// Consumer-side cache for HTTP mode — mirrors fs-bridge/cache.js patterns.
// Sits above remote-fs-node's binding-level patch: wraps JS-level fs methods
// with a 60s TTL in-memory cache, and makes realpathSync a string transform
// for remote paths (matching SSH mode's fs-bridge/sync-ops.js:181-188).

const TTL = 60000; // 60s, cleared on mutation — no disk cache
const _cache = new Map();

// Virtual workspace prefix /◦<host>∶<port>/ is auto-applied to the agent's cwd (boxId derived
// from host:port in config.js). qoder resolves paths against process.cwd() so every fs call
// carries the prefix, but prefetchStartup stores cache entries with unprefixed paths (via
// getRemoteCwd → toRemote). Without stripping the prefix in _norm, every lookup key mismatches
// and ALL prefetched entries miss the cache — defeating the acceleration entirely.
const { toRemote, hasWorkspacePrefix } = require("./classifier");

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

function _cInv(p) {
  ["stat", "lstat", "read", "exists", "readdir", "access"].forEach((t) => _cache.delete(t + ":" + p));
  const li = p.lastIndexOf("/");
  if (li > 0) _cache.delete("readdir:" + p.slice(0, li));
  try { require("remote-fs-node/lib/sync-bridge").invalidateFsPath(p); } catch (_) {}
}

// ─── install: wrap fs methods with consumer cache ───────────────────────
function install(fsObj, isRemote) {
  // Enable sync bridge response cache — catches ALL sync fs HTTP calls at the
  // transport level, regardless of which JS API initiated them. This is essential
  // because remote-fs-node's internal sync wrappers bypass all JS-level wrappers.
  try {
    const sb = require("remote-fs-node/lib/sync-bridge");
    if (sb.enableFsCache) sb.enableFsCache(true);
  } catch (_) {}

  const _existsSync = fsObj.existsSync;
  const _statSync = fsObj.statSync;
  const _lstatSync = fsObj.lstatSync;
  const _realpathSync = fsObj.realpathSync;
  const _readdirSync = fsObj.readdirSync;

  function _norm(p) {
    let s = Buffer.isBuffer(p) ? p.toString("utf8") : String(p).replace(/\\/g, "/");
    if (hasWorkspacePrefix(s)) s = toRemote(s);
    return s;
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
        if (cached !== undefined) {
          return cached instanceof Error ? Promise.reject(cached) : Promise.resolve(cached);
        }
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
        if (cached !== undefined) {
          return cached instanceof Error ? Promise.reject(cached) : Promise.resolve(cached);
        }
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

  // ── require("fs/promises") — separate module from fs.promises ──────────
  // Node.js: require("fs/promises") !== require("fs").promises. qoder and many
  // libraries import from "node:fs/promises" directly, bypassing the fs.promises
  // wrappers above. Wrap the separate module with the same cache.
  try {
    const pMod = require("fs/promises");
    if (pMod && pMod !== fsObj.promises) {
      const _pmStat = pMod.stat;
      if (typeof _pmStat === "function") {
        pMod.stat = function (p, opts) {
          const np = _norm(p);
          if (!isRemote(np)) return _pmStat.call(pMod, p, opts);
          const cached = _cGet("stat", np);
          if (cached !== undefined) return cached instanceof Error ? Promise.reject(cached) : Promise.resolve(cached);
          return _pmStat.call(pMod, p, opts).then(r => { _cSet("stat", np, r); return r; })
            .catch(e => { if (e.code === "ENOENT") _cSet("stat", np, e); throw e; });
        };
      }
      const _pmLstat = pMod.lstat;
      if (typeof _pmLstat === "function") {
        pMod.lstat = function (p, opts) {
          const np = _norm(p);
          if (!isRemote(np)) return _pmLstat.call(pMod, p, opts);
          const cached = _cGet("lstat", np);
          if (cached !== undefined) return cached instanceof Error ? Promise.reject(cached) : Promise.resolve(cached);
          return _pmLstat.call(pMod, p, opts).then(r => { _cSet("lstat", np, r); return r; })
            .catch(e => { if (e.code === "ENOENT") _cSet("lstat", np, e); throw e; });
        };
      }
      const _pmReadFile = pMod.readFile;
      if (typeof _pmReadFile === "function") {
        pMod.readFile = function (p, opts) {
          const np = _norm(p);
          if (!isRemote(np)) return _pmReadFile.call(pMod, p, opts);
          const cached = _cGet("read", np);
          if (cached !== undefined) return cached instanceof Error ? Promise.reject(cached) : Promise.resolve(cached);
          return _pmReadFile.call(pMod, p, opts).then(r => { if (_cacheableRead(r)) _cSet("read", np, r); return r; })
            .catch(e => { if (e.code === "ENOENT") _cSet("read", np, e); throw e; });
        };
      }
      const _pmAccess = pMod.access;
      if (typeof _pmAccess === "function") {
        pMod.access = function (p, mode) {
          const np = _norm(p);
          if (!isRemote(np)) return _pmAccess.call(pMod, p, mode);
          const cached = _cGet("access", np);
          if (cached !== undefined) return cached instanceof Error ? Promise.reject(cached) : Promise.resolve();
          return _pmAccess.call(pMod, p, mode).then(() => { _cSet("access", np, null); })
            .catch(e => { if (e.code === "ENOENT") _cSet("access", np, e); throw e; });
        };
      }
      const _pmReaddir = pMod.readdir;
      if (typeof _pmReaddir === "function") {
        pMod.readdir = function (p, opts) {
          const np = _norm(p);
          if (!isRemote(np)) return _pmReaddir.call(pMod, p, opts);
          const cached = _cGet("readdir", np);
          if (cached !== undefined) return cached instanceof Error ? Promise.reject(cached) : Promise.resolve(cached);
          return _pmReaddir.call(pMod, p, opts).then(r => { _cSet("readdir", np, r); return r; })
            .catch(e => { if (e.code === "ENOENT") _cSet("readdir", np, e); throw e; });
        };
      }
      // realpath: string transform for remote paths — no server call (matches
      // fsObj.promises.realpath wrapper above). Without this, qoder's
      // import {realpath} from "node:fs/promises" hits POST /api/fs/realpath.
      const _pmRealpath = pMod.realpath;
      if (typeof _pmRealpath === "function") {
        pMod.realpath = function (p, opts) {
          const np = _norm(p);
          if (isRemote(np)) return Promise.resolve(np);
          return _pmRealpath.call(pMod, p, opts);
        };
      }
    }
  } catch (_) {}

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

  // ── Binding-level _impl wrappers — intercept ALL fs calls ───────────────
  // qoder's fs calls go through remote-fs-node's binding dispatcher, which calls
  // _impl methods directly — bypassing all JS-level wrappers above. Wrapping _impl
  // here catches every call regardless of which JS API initiated it. The dispatcher
  // re-reads _impl[key] on every call, so replacing methods after patchBinding()
  // is automatically picked up.
  try {
    const bindingMod = require("remote-fs-node/lib/binding");
    if (bindingMod._impl) {
      const impl = bindingMod._impl;

      if (typeof impl.stat === "function") {
        const _orig = impl.stat;
        impl.stat = async function (args) {
          const p = _norm(args[0]);
          const cached = _cGet("stat", p);
          if (cached !== undefined) {
            if (cached instanceof Error) throw cached;
            return cached;
          }
          try {
            const result = await _orig.call(impl, args);
            _cSet("stat", p, result);
            return result;
          } catch (err) {
            if (err && err.code === "ENOENT") _cSet("stat", p, err);
            throw err;
          }
        };
      }

      if (typeof impl.lstat === "function") {
        const _orig = impl.lstat;
        impl.lstat = async function (args) {
          const p = _norm(args[0]);
          const cached = _cGet("lstat", p);
          if (cached !== undefined) {
            if (cached instanceof Error) throw cached;
            return cached;
          }
          try {
            const result = await _orig.call(impl, args);
            _cSet("lstat", p, result);
            return result;
          } catch (err) {
            if (err && err.code === "ENOENT") _cSet("lstat", p, err);
            throw err;
          }
        };
      }

      if (typeof impl.readdir === "function") {
        const _orig = impl.readdir;
        impl.readdir = async function (args) {
          const p = _norm(args[0]);
          const cached = _cGet("readdir", p);
          if (cached !== undefined) {
            if (cached instanceof Error) throw cached;
            return cached;
          }
          try {
            const result = await _orig.call(impl, args);
            _cSet("readdir", p, result);
            return result;
          } catch (err) {
            if (err && err.code === "ENOENT") _cSet("readdir", p, err);
            throw err;
          }
        };
      }

      if (typeof impl.readFileUtf8 === "function") {
        const _orig = impl.readFileUtf8;
        impl.readFileUtf8 = async function (args) {
          const p = _norm(args[0]);
          const cached = _cGet("read", p);
          if (cached !== undefined) {
            if (cached instanceof Error) throw cached;
            return typeof cached === "string" ? cached : cached.toString("utf8");
          }
          try {
            const result = await _orig.call(impl, args);
            if (typeof result === "string" && result.length <= 262144) _cSet("read", p, Buffer.from(result, "utf8"));
            return result;
          } catch (err) {
            if (err && err.code === "ENOENT") _cSet("read", p, err);
            throw err;
          }
        };
      }

      if (typeof impl.access === "function") {
        const _orig = impl.access;
        impl.access = async function (args) {
          const p = _norm(args[0]);
          const cached = _cGet("access", p);
          if (cached !== undefined) {
            if (cached instanceof Error) throw cached;
            return;
          }
          try {
            const result = await _orig.call(impl, args);
            _cSet("access", p, null);
            return result;
          } catch (err) {
            if (err && err.code === "ENOENT") _cSet("access", p, err);
            throw err;
          }
        };
      }
    }
  } catch (_) {}
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
    const twoPaths = m === "rename" || m === "copyFile" || m === "renameSync" || m === "copyFileSync";
    fsObj[m] = function (...args) {
      const p = _norm(args[0]);
      if (isRemote(p)) _cInv(p);
      if (twoPaths && args[1] != null) { const p2 = _norm(args[1]); if (isRemote(p2)) _cInv(p2); }
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
      const twoPaths = m === "rename" || m === "copyFile";
      fsObj.promises[m] = function (...args) {
        const p = _norm(args[0]);
        if (isRemote(p)) _cInv(p);
        if (twoPaths && args[1] != null) { const p2 = _norm(args[1]); if (isRemote(p2)) _cInv(p2); }
        return orig.apply(fsObj.promises, args);
      };
    }
  }
  // fs/promises mutators
  try {
    const pMod = require("fs/promises");
    if (pMod && pMod !== fsObj.promises) {
      for (const m of ["writeFile", "mkdir", "rm", "rmdir", "unlink", "rename", "copyFile", "appendFile", "chmod", "chown", "utimes", "symlink"]) {
        const orig = pMod[m];
        if (typeof orig !== "function") continue;
        const twoPaths = m === "rename" || m === "copyFile";
        pMod[m] = function (...args) {
          const p = _norm(args[0]);
          if (isRemote(p)) _cInv(p);
          if (twoPaths && args[1] != null) { const p2 = _norm(args[1]); if (isRemote(p2)) _cInv(p2); }
          return orig.apply(pMod, args);
        };
      }
    }
  } catch (_) {}
}

// ─── Startup batching ───────────────────────────────────────────────────
// Batch all adapter prefetch paths (exists + stat + read + readdir + access)
// via a few exec calls. Results injected into the TTL cache so subsequent
// fs calls during init hit cache instead of making HTTP round-trips.
// Centralized init list lives in the adapter's getPrefetchPaths.
function prefetchStartup(exec, cfg, adapter, getRemoteCwd) {
  if (!adapter || !adapter.getPrefetchPaths || !exec || !exec.sftpExec) return;
  try {
    const cwd = getRemoteCwd();
    const parent = cwd.replace(/\/[^/]+$/, "") || "/";
    const pf = adapter.getPrefetchPaths(cwd, parent);
    if (!pf) return;
    let n = 0;
    const run = (cmd) => { try { return exec.sftpExec(cmd); } catch (_) { return null; } };

    // Sync bridge cache population — stores HTTP responses so first calls hit cache
    let sbSet = null;
    try {
      const sb = require("remote-fs-node/lib/sync-bridge");
      if (sb.setFsCacheEntry) sbSet = sb.setFsCacheEntry;
    } catch (_) {}
    const enc = (p) => encodeURIComponent(p);
    const statJson = (type, size, mtime, atime, ctime, perm, uid, gid) =>
      JSON.stringify({ atime: atime, birthtime: ctime, blksize: 4096, blocks: 0, ctime: ctime, dev: 0, fullMode: parseInt(perm, 8) || 0, gid: gid, ino: 0, mode: "0o" + parseInt(perm, 8).toString(8), mtime: mtime, nlink: 1, rdev: 0, size: size, type: type, uid: uid });
    const notFoundBody = Buffer.from('{"error":"not found"}', "utf8");

    // ── exists + access batch: `test -e` per path, tagged output ──
    const existPaths = [...(pf.exists || []), ...(pf.access || [])];
    if (existPaths.length) {
      const tests = existPaths
        .map((p) => "if test -e " + JSON.stringify(p) + "; then printf '" + p + "\\t1\\n'; else printf '" + p + "\\t0\\n'; fi")
        .join(";");
      const r = run(tests);
      if (r) for (const line of r.stdout.toString("utf8").split("\n")) {
        const m = line.split("\t");
        if (m.length === 2) {
          const v = m[1] === "1";
          _cSet("exists", m[0], v);
          _cSet("access", m[0], v ? null : _enoent(m[0]));
          n++;
        }
      }
    }

    // ── stat batch: `stat -c` for all paths → Stats objects in both stat + lstat ──
    if (pf.stat && pf.stat.length) {
      try {
        const { Stats } = require("remote-fs-node/lib/stats");
        const args = pf.stat.map((p) => JSON.stringify(p)).join(" ");
        const r = run("stat -c '%n|%F|%s|%Y|%X|%Z|%a|%u|%g' " + args + " 2>/dev/null");
        const seen = new Set();
        if (r) {
          const out = r.stdout.toString("utf8").trim();
          const typeMap = { "regular file": "file", "directory": "dir", "symbolic link": "symlink" };
          for (const line of out.split("\n")) {
            const f = line.split("|");
            if (f.length < 9) continue;
            const [name, type, size, mtime, atime, ctime, perm, uid, gid] = f;
            seen.add(name);
            const tType = typeMap[type] || "file";
            const tSize = parseInt(size, 10) || 0;
            const tMtime = parseFloat(mtime) * 1000 || 0;
            const tAtime = parseFloat(atime) * 1000 || 0;
            const tCtime = parseFloat(ctime) * 1000 || 0;
            const tUid = parseInt(uid, 10) || 0;
            const tGid = parseInt(gid, 10) || 0;
            const st = new Stats({ type: tType, size: tSize, mode: perm, mtime: tMtime, atime: tAtime, ctime: tCtime, uid: tUid, gid: tGid });
            _cSet("stat", name, st);
            _cSet("lstat", name, st);
            if (sbSet) {
              const body = Buffer.from(statJson(tType, tSize, tMtime, tAtime, tCtime, perm, tUid, tGid), "utf8");
              sbSet("/api/fs/stat?path=" + enc(name) + "&follow=false", 200, body);
              sbSet("/api/fs/stat?path=" + enc(name) + "&follow=true", 200, body);
            }
            n++;
          }
        }
        // Cache ENOENT for paths that didn't appear in stat output (don't exist)
        for (const p of pf.stat) {
          if (!seen.has(p)) {
            const err = _enoent(p);
            _cSet("stat", p, err);
            _cSet("lstat", p, err);
            if (sbSet) {
              sbSet("/api/fs/stat?path=" + enc(p) + "&follow=false", 404, notFoundBody);
              sbSet("/api/fs/stat?path=" + enc(p) + "&follow=true", 404, notFoundBody);
            }
            n++;
          }
        }
      } catch (_) {}
    }

    // ── read batch: `cat … | base64` per file, tagged output ──
    if (pf.read && pf.read.length) {
      const cmds = pf.read
        .map((p) => "printf 'R\\t" + p + "\\t'; cat " + JSON.stringify(p) + " 2>/dev/null | base64 | tr -d '\\n'; printf '\\n'")
        .join(";");
      const r = run(cmds);
      if (r) for (const line of r.stdout.toString("utf8").split("\n")) {
        const f = line.split("\t");
        if (f.length >= 3 && f[0] === "R") {
          if (f[2]) {
            const buf = Buffer.from(f[2], "base64");
            _cSet("read", f[1], buf);
            if (sbSet) sbSet("/api/fs/read?path=" + enc(f[1]), 200, buf);
            n++;
          } else {
            _cSet("read", f[1], _enoent(f[1]));
            if (sbSet) sbSet("/api/fs/read?path=" + enc(f[1]), 404, notFoundBody);
            n++;
          }
        }
      }
    }

    // ── readdir batch: `ls -1F` per dir, entries delimited by \037 (0x1f, POSIX octal) ──
    // ls -1F appends type indicators: / = dir, @ = symlink, * = executable, none = file.
    // \037 (octal) is used instead of \x1f because not all `tr` implementations support
    // \x hex escapes (GNU tr on some systems treats \x1f as literal "x"), but \037 is POSIX.
    if (pf.readdir && pf.readdir.length) {
      const cmds = pf.readdir
        .map((p) => "printf 'L\\t" + p + "\\t'; ls -1F " + JSON.stringify(p) + " 2>/dev/null | tr '\\n' '\\037'; printf '\\n'")
        .join(";");
      const r = run(cmds);
      if (r) for (const line of r.stdout.toString("utf8").split("\n")) {
        const f = line.split("\t");
        if (f.length >= 3 && f[0] === "L") {
          if (f[2]) {
            const raw = f[2].split("\x1f").filter(Boolean);
            const entries = raw.map((e) => e.replace(/[/@*]$/, ""));
            _cSet("readdir", f[1], entries);
            if (sbSet) sbSet("/api/fs/list?path=" + enc(f[1]), 200, Buffer.from(JSON.stringify(raw.map((e) => {
              const isDir = e.endsWith("/");
              const isLink = e.endsWith("@");
              return { name: e.replace(/[/@*]$/, ""), type: isDir ? "dir" : isLink ? "symlink" : "file" };
            })), "utf8"));
            n++;
          } else {
            _cSet("readdir", f[1], _enoent(f[1]));
            if (sbSet) sbSet("/api/fs/list?path=" + enc(f[1]), 404, notFoundBody);
            n++;
          }
        }
      }
    }

    return n;
  } catch (_) {
    return 0;
  }
}

function _enoent(p) {
  const e = new Error("ENOENT: no such file or directory, access '" + p + "'");
  e.code = "ENOENT"; e.errno = -2; e.syscall = "access"; e.path = p;
  return e;
}

module.exports = { install, prefetchStartup };