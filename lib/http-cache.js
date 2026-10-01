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

  // Cache invalidation on mutations — wrap key mutating methods.
  const _mutators = [
    "writeFileSync", "mkdirSync", "rmSync", "rmdirSync", "unlinkSync",
    "renameSync", "copyFileSync", "appendFileSync", "truncateSync",
    "chmodSync", "chownSync", "utimesSync", "symlinkSync",
  ];
  for (const m of _mutators) {
    const orig = fsObj[m];
    if (typeof orig !== "function") continue;
    fsObj[m] = function (...args) {
      _cClear();
      return orig.apply(fsObj, args);
    };
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
// Batch test -e for all adapter prefetch paths via one exec call.
// Results injected into the consumer cache so subsequent existsSync calls hit.
function prefetchStartup(exec, cfg, adapter, getRemoteCwd) {
  if (!adapter || !adapter.getPrefetchPaths || !exec || !exec.sftpExec) return;
  try {
    const cwd = getRemoteCwd();
    const parent = cwd.replace(/\/[^/]+$/, "") || "/";
    const pf = adapter.getPrefetchPaths(cwd, parent);
    if (!pf || !pf.exists || !pf.exists.length) return;

    const tests = pf.exists
      .map((p) => "if test -e " + JSON.stringify(p) + "; then printf '" + p + "\\t1\\n'; else printf '" + p + "\\t0\\n'; fi")
      .join(";");
    const r = exec.sftpExec(tests);
    const lines = r.stdout.toString("utf8").split("\n");
    let n = 0;
    for (const line of lines) {
      const m = line.split("\t");
      if (m.length === 2) {
        _cSet("exists", m[0], m[1] === "1");
        n++;
      }
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