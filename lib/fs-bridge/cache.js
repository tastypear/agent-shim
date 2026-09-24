const path = require("path");

function install(ctx) {
  const { sftp, sftpCall, sftpExec, OP, fs, cfg, getRemoteCwd } = ctx;
  const logger = require("../logger").child("fs");

  const cache = new Map();
  const TTL = 60000;
  const cGet = (t, k) => {
    const e = cache.get(t + ":" + k);
    if (e && Date.now() - e.t < TTL) return e.v;
    return undefined;
  };
  const cSet = (t, k, v) => cache.set(t + ":" + k, { v, t: Date.now() });
  const cInv = (k) => {
    ["stat", "read", "exists", "readdir"].forEach((t) => cache.delete(t + ":" + k));
    const norm = String(k).replace(/\\/g, "/");
    const li = norm.lastIndexOf("/");
    if (li > 0) cache.delete("readdir:" + norm.slice(0, li));
  };
  ctx.cGet = cGet; ctx.cSet = cSet; ctx.cInv = cInv;

  const PROBE_FILES = new Set([
    "/proc/version", "/proc/1/cgroup", "/proc/self/cgroup",
    "/etc/machine-id", "/var/lib/dbus/machine-id",
    "/etc/os-release", "/etc/wsl.conf",
  ]);
  const PROBE_EXISTS = new Set([
    "/.dockerenv", "/.dockerinit", "/run/.containerenv", "/etc/wsl.conf",
    "/proc/1/cgroup",
  ]);
  const REFRESH = process.env.REMOTE_BRIDGE_REFRESH_CACHE === "1";
  let diskCache = null;
  let diskDirty = false;

  // Read the per-connection cache file. Falls back to a one-time migration from the
  // legacy single cache (.remote-bridge-cache.json) when host matches, so an upgrade
  // doesn't discard existing probe results.
  try {
    if (cfg && cfg.cacheFile) {
      diskCache = JSON.parse(fs.readFileSync(cfg.cacheFile, "utf8"));
    }
  } catch (e) {
    diskCache = null;
  }
  if (!diskCache && cfg && cfg.cacheDir) {
    const legacy = path.join(cfg.cacheDir, ".remote-bridge-cache.json");
    try {
      const old = JSON.parse(fs.readFileSync(legacy, "utf8"));
      if (old.host === cfg.host) {
        diskCache = { host: cfg.host, exists: old.exists || {}, read: old.read || {} };
        diskDirty = true;
        logger.info("probe cache: migrated from legacy " + path.basename(legacy));
      }
    } catch (e) {
      // no legacy file, or wrong host — start fresh
    }
  }
  // Per-connection files should never mismatch host; refresh if one does (e.g. a
  // hand-copied file) rather than serve wrong probe data.
  if (diskCache && cfg && diskCache.host !== cfg.host) {
    logger.warn("probe cache: host mismatch in " + (cfg.cacheFile || "?") + " — refreshing");
    diskCache = { host: cfg.host, exists: {}, read: {} };
    diskDirty = true;
  }
  if (!diskCache) diskCache = { host: cfg && cfg.host, exists: {}, read: {} };
  if (REFRESH) {
    logger.info("probe cache: force refresh requested");
    diskCache = { host: cfg && cfg.host, exists: {}, read: {} };
    diskDirty = true;
  }
  // Fold this run's HOME/osRelease probes into the disk cache so the next startup
  // reads them without a blocking SFTP round-trip.
  if (ctx.probes && !REFRESH) {
    if (ctx.probes.home && diskCache.home !== ctx.probes.home) {
      diskCache.home = ctx.probes.home;
      diskDirty = true;
    }
    if (ctx.probes.osRelease && diskCache.uname !== ctx.probes.osRelease) {
      diskCache.uname = ctx.probes.osRelease;
      diskDirty = true;
    }
  }
  let _flushTimer = null;
  function flushDiskCache() {
    if (!diskDirty || !cfg || !cfg.cacheFile) return;
    try {
      fs.writeFileSync(cfg.cacheFile, JSON.stringify(diskCache, null, 2));
      diskDirty = false;
    } catch (e) {
      logger.warn("probe cache: write failed: " + e.message);
    }
  }
  function scheduleFlush() {
    if (!diskDirty) return;
    if (_flushTimer) return;
    _flushTimer = setTimeout(() => { _flushTimer = null; flushDiskCache(); }, 500);
  }
  process.on("exit", flushDiskCache);
  process.on("SIGTERM", () => { flushDiskCache(); process.exit(0); });
  process.on("SIGINT", () => { flushDiskCache(); process.exit(0); });

  function sRead(p) {
    const c = cGet("read", p);
    if (c !== undefined) return c;
    if (PROBE_FILES.has(p) && diskCache.read[p] !== undefined) {
      return Buffer.from(diskCache.read[p], "base64");
    }
    const _t = Date.now();
    const r = sftpCall(OP.readFile, p);
    logger.info("fs.readFile " + p + " -> " + (Date.now()-_t) + "ms");
    cSet("read", p, r);
    if (PROBE_FILES.has(p)) {
      diskCache.read[p] = r.toString("base64");
      diskDirty = true;
      scheduleFlush();
    }
    return r;
  }
  function sWrite(p, d) {
    const _t = Date.now();
    sftpCall(OP.writeFile, p, Buffer.isBuffer(d) ? d : Buffer.from(String(d)));
    logger.info("fs.writeFile " + p + " -> " + (Date.now()-_t) + "ms");
    cInv(p);
  }
  function sReaddir(p) {
    const c = cGet("readdir", p);
    if (c) return c;
    const _t = Date.now();
    const r = JSON.parse(sftpCall(OP.readdir, p).toString("utf8"));
    logger.info("fs.readdir " + p + " -> " + (Date.now()-_t) + "ms");
    cSet("readdir", p, r);
    return r;
  }

  const _cwd = getRemoteCwd();
  const _parent = _cwd.replace(/\/[^/]+$/, "") || "/";
  const _pf = ctx.adapter.getPrefetchPaths(_cwd, _parent);
  const PREFETCH_PATHS = _pf.exists;
  let _prefetched = false;
  function prefetchStartupExists() {
    if (_prefetched) return;
    _prefetched = true;
    const tests = PREFETCH_PATHS.map((p) => "if test -e " + JSON.stringify(p) + "; then printf '" + p + "\\t1\\n'; else printf '" + p + "\\t0\\n'; fi").join(";");
    const _t = Date.now();
    try {
      const r = sftp.sftpExec(tests);
      const lines = r.stdout.toString("utf8").split("\n");
      let n = 0;
      for (const line of lines) {
        const m = line.split("\t");
        if (m.length === 2) { cSet("exists", m[0], m[1] === "1"); n++; }
      }
      logger.info("startup exists prefetch: " + n + " paths in " + (Date.now()-_t) + "ms");
    } catch (e) {
      logger.info("startup exists prefetch FAILED: " + e.message);
    }
  }
  const PREFETCH_SET = new Set(PREFETCH_PATHS);

  const PREFETCH_STAT_PATHS = _pf.stat;
  const PREFETCH_STAT_SET = new Set(PREFETCH_STAT_PATHS);
  let _statPrefetched = false;
  let _statPrintfOk = null;
  function prefetchStartupStat() {
    if (_statPrefetched) return;
    _statPrefetched = true;
    if (_statPrintfOk === false) return;
    const args = PREFETCH_STAT_PATHS.map((p) => JSON.stringify(p)).join(" ");
    const cmd = "stat -c '%n|%F|%s|%Y|%X|%Z|%a|%u|%g' " + args + " 2>/dev/null";
    const _t = Date.now();
    try {
      const r = sftp.sftpExec(cmd);
      const out = r.stdout.toString("utf8").trim();
      if (!out || r.exitCode !== 0) {
        _statPrintfOk = false;
        logger.info("stat -c unavailable, falling back to per-path lstat");
        return;
      }
      _statPrintfOk = true;
      for (const line of out.split("\n")) {
        const f = line.split("|");
        if (f.length < 9) continue;
        const [name, type, size, mtime, atime, ctime, perm, uid, gid] = f;
        const st = {
          size: parseInt(size, 10) || 0,
          mode: parseInt(perm, 8) || 0,
          isFile: type === "regular file",
          isDirectory: type === "directory",
          isSymbolicLink: type === "symbolic link",
          mtimeMs: parseFloat(mtime) * 1000 || 0,
          atimeMs: parseFloat(atime) * 1000 || 0,
          ctimeMs: parseFloat(ctime) * 1000 || 0,
          uid: parseInt(uid, 10) || 0,
          gid: parseInt(gid, 10) || 0,
          dev: 0, ino: 0, nlink: 1, rdev: 0, blksize: 4096, blocks: 0,
        };
        cSet("stat", name, st);
      }
      logger.info("startup stat prefetch: " + PREFETCH_STAT_PATHS.length + " paths in " + (Date.now()-_t) + "ms");
    } catch (e) {
      _statPrintfOk = false;
      logger.info("startup stat prefetch FAILED: " + e.message);
    }
  }

  function sStat(p) {
    const c = cGet("stat", p);
    if (c) return c;
    if (PREFETCH_STAT_SET.has(p)) {
      prefetchStartupStat();
      const cached = cGet("stat", p);
      if (cached) {
        logger.info("fs.lstat " + p + " -> (prefetch cache)");
        return cached;
      }
    }
    const _t = Date.now();
    const r = JSON.parse(sftpCall(OP.lstat, p).toString("utf8"));
    logger.info("fs.lstat " + p + " -> " + (Date.now()-_t) + "ms");
    cSet("stat", p, r);
    return r;
  }
  function sExists(p) {
    const c = cGet("exists", p);
    if (c !== undefined) return c;
    if (PROBE_EXISTS.has(p) && diskCache.exists[p] !== undefined) {
      return diskCache.exists[p];
    }
    if (PREFETCH_SET.has(p)) {
      prefetchStartupExists();
      const cached = cGet("exists", p);
      if (cached !== undefined) {
        logger.info("fs.exists " + p + " -> (prefetch cache) " + cached);
        return cached;
      }
    }
    const _t = Date.now();
    const r = JSON.parse(sftpCall(OP.exists, p).toString("utf8")).exists;
    logger.info("fs.exists " + p + " -> " + (Date.now()-_t) + "ms");
    cSet("exists", p, r);
    if (PROBE_EXISTS.has(p)) {
      diskCache.exists[p] = r;
      diskDirty = true;
      scheduleFlush();
    }
    return r;
  }

  let _refreshed = false;
  async function refreshProbesAsync() {
    if (_refreshed || !sftp.sftpExecAsync) return;
    _refreshed = true;
    try {
      const readPromises = [];
      for (const p of PROBE_FILES) {
        readPromises.push(
          sftp.sftpExecAsync("cat " + p + " 2>/dev/null || true").then((r) => {
            if (r.exitCode === 0 && r.stdout.length > 0) {
              diskCache.read[p] = Buffer.from(r.stdout).toString("base64");
              diskDirty = true;
            }
          }).catch(() => {})
        );
      }
      const existPromises = [];
      for (const p of PROBE_EXISTS) {
        existPromises.push(
          sftp.sftpExecAsync("test -e " + p + " && echo y || echo n").then((r) => {
            const v = r.stdout.toString().trim() === "y";
            diskCache.exists[p] = v;
            diskDirty = true;
          }).catch(() => {})
        );
      }
      // Refresh HOME + uname for next startup's fast path.
      const envPromises = [
        sftp.sftpExecAsync("echo $HOME").then((r) => {
          const h = r.stdout.toString("utf8").trim();
          if (h) { diskCache.home = h; diskDirty = true; }
        }).catch(() => {}),
      ];
      if (ctx.adapter && ctx.adapter.needsOsReleaseFake && ctx.adapter.needsOsReleaseFake()) {
        envPromises.push(
          sftp.sftpExecAsync("uname -r").then((r) => {
            const v = r.stdout.toString("utf8").trim();
            if (v) { diskCache.uname = v; diskDirty = true; }
          }).catch(() => {})
        );
      }
      await Promise.all([...readPromises, ...existPromises, ...envPromises]);
      flushDiskCache();
      logger.info("probe cache: async refresh done");
    } catch (e) {}
  }

  Object.assign(ctx, {
    sRead, sWrite, sReaddir, sStat, sExists,
    prefetchStartupExists, refreshProbesAsync,
    PROBE_FILES, PROBE_EXISTS, PREFETCH_SET, PREFETCH_STAT_SET,
  });
}

module.exports = { install };
