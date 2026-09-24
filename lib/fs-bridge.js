// lib/fs-bridge.js
// Patches fs (sync + async), fs.promises, streams, watch, and Module._load so that
// remote paths (posix-absolute, no drive) route through SFTP, while local paths
// (drive-qualified) use the original native fs.
//
// Also intercepts Module._load to return a fake node-pty (platform=linux makes qoder try
// to load the Linux native pty.node binding, which doesn't exist on Windows) and to route
// fs/promises imports through the patched promises object.

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { Readable, Writable } = require("stream");
const { EventEmitter } = require("events");
const Module = require("module");

const { isRemote, toRemote } = require("./classifier");

function apply(sftp, getRemoteCwd, cfg) {
  const { sftpCall, sftpExec, OP } = sftp;
  const fs = require("fs");
  const path = require("path");

  // ===== Cache =====
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
    // Invalidate parent dir's readdir cache — file add/remove/rename changes the listing.
    const norm = String(k).replace(/\\/g, "/");
    const li = norm.lastIndexOf("/");
    if (li > 0) cache.delete("readdir:" + norm.slice(0, li));
  };

  // ===== Disk-persisted probe cache =====
  // qoder probes a fixed set of environment paths at startup (machine-id, /proc/version,
  // dockerenv, cgroup, etc). Each is a synchronous SFTP round-trip (~300ms exists, ~1200ms
  // read on a high-RTT remote). Results are stable for the remote's lifetime, so we persist
  // them to disk and reuse across qoder restarts. First launch fetches + writes; subsequent
  // launches read local cache (instant). REMOTE_BRIDGE_REFRESH_CACHE=1 forces re-fetch.
  //
  // Paths that are NOT stable (project files: .git, AGENTS.md, settings, skills) are NOT
  // cached here — those change at user will and must be probed live (or batch-fetched).
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
  try {
    if (cfg && cfg.cachePath) {
      const raw = fs.readFileSync(cfg.cachePath, "utf8");
      diskCache = JSON.parse(raw);
      // Bind to host: if the config now points at a different host, discard cached probes.
      if (diskCache.host !== cfg.host) {
        process.stderr.write("[launcher] probe cache: host changed (" + (diskCache.host||"?") + " -> " + cfg.host + "), refreshing\n");
        diskCache = { host: cfg.host, exists: {}, read: {} };
        diskDirty = true;
      }
    }
  } catch (e) {
    diskCache = { host: cfg && cfg.host, exists: {}, read: {} };
  }
  if (!diskCache) diskCache = { host: cfg && cfg.host, exists: {}, read: {} };
  if (REFRESH) {
    process.stderr.write("[launcher] probe cache: force refresh requested\n");
    diskCache = { host: cfg && cfg.host, exists: {}, read: {} };
    diskDirty = true;
  }
  let _flushTimer = null;
  function flushDiskCache() {
    if (!diskDirty || !cfg || !cfg.cachePath) return;
    try {
      fs.writeFileSync(cfg.cachePath, JSON.stringify(diskCache, null, 2));
      diskDirty = false;
    } catch (e) {
      process.stderr.write("[launcher] probe cache: write failed: " + e.message + "\n");
    }
  }
  function scheduleFlush() {
    if (!diskDirty) return;
    if (_flushTimer) return;
    // Debounce: write once 500ms after the last probe fetch, so a burst of probes
    // at startup results in a single write rather than N.
    _flushTimer = setTimeout(() => { _flushTimer = null; flushDiskCache(); }, 500);
  }
  // Best-effort persist on exit (covers normal shutdown; SIGKILL can't be caught).
  process.on("exit", flushDiskCache);
  process.on("SIGTERM", () => { flushDiskCache(); process.exit(0); });
  process.on("SIGINT", () => { flushDiskCache(); process.exit(0); });

  function sRead(p) {
    const c = cGet("read", p);
    if (c !== undefined) return c;
    // Disk-persisted probe cache: environment files stable across restarts.
    if (PROBE_FILES.has(p) && diskCache.read[p] !== undefined) {
      return Buffer.from(diskCache.read[p], "base64");
    }
    const _t = Date.now();
    const r = sftpCall(OP.readFile, p);
    process.stderr.write("[launcher] fs.readFile " + p + " -> " + (Date.now()-_t) + "ms\n");
    cSet("read", p, r);
    // Persist probe reads to disk for next launch.
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
    process.stderr.write("[launcher] fs.writeFile " + p + " -> " + (Date.now()-_t) + "ms\n");
    cInv(p);
  }
  function sReaddir(p) {
    const c = cGet("readdir", p);
    if (c) return c;
    const _t = Date.now();
    const r = JSON.parse(sftpCall(OP.readdir, p).toString("utf8"));
    process.stderr.write("[launcher] fs.readdir " + p + " -> " + (Date.now()-_t) + "ms\n");
    cSet("readdir", p, r);
    return r;
  }
  // ===== Batch prefetch for startup structure probes =====
  // qoder probes ~15 existsSync calls at startup. Each is a separate SFTP stat round-trip
  // (~300ms on high-RTT remote). Batch all into ONE exec command (test -e for each path)
  // via sftpExec — a single round-trip (~700ms) replaces 15 (~4.5s).
  //
  // Paths are derived from the remote cwd (vcwd), not hardcoded: qoder probes
  // <cwd>/.git, <cwd>/.qoder/*, <cwd>/AGENTS.md, and walks up to <parent>/.git etc.
  const _cwd = getRemoteCwd();
  const _parent = _cwd.replace(/\/[^/]+$/, "") || "/";
  // joinPath: avoid double-slash when parent is "/" (e.g. "/" + "/.git" = "//.git").
  const _pp = (base, rel) => (base === "/" ? "/" + rel : base + "/" + rel);
  const PREFETCH_PATHS = [
    _cwd + "/.qoder/settings.json", _cwd + "/.qoder/settings.local.json", _cwd + "/.qoder/.env",
    _cwd + "/.qoder/skills", _cwd + "/.qoder/commands", _cwd + "/.qoder",
    _cwd + "/.git", _cwd + "/.agents", _cwd + "/.agents/skills",
    _cwd + "/AGENTS.md", _cwd + "/AGENTS.local.md",
    _cwd + "/packages/qoder/package.json", _pp(_parent, "packages/qoder/package.json"),
    _pp(_parent, ".git"), _cwd,
  ];
  let _prefetched = false;
  function prefetchStartupExists() {
    if (_prefetched) return;
    _prefetched = true;
    // Synchronous: qoder's existsSync calls are synchronous, so an async prefetch would
    // race and lose (qoder queries before the Promise resolves). Block once on a single
    // exec command that tests all paths, fill the cache, then every subsequent existsSync
    // hits cache. One ~600ms round-trip replaces ~14 × 300ms = 4.2s.
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
      process.stderr.write("[launcher] startup exists prefetch: " + n + " paths in " + (Date.now()-_t) + "ms\n");
    } catch (e) {
      process.stderr.write("[launcher] startup exists prefetch FAILED: " + e.message + "\n");
    }
  }
  // Trigger prefetch on first existsSync for any prefetch path.
  const PREFETCH_SET = new Set(PREFETCH_PATHS);

  // ===== Batch prefetch for startup lstat calls =====
  // Same idea as exists prefetch: qoder lstats a few paths at startup (cwd, cwd/.qoder,
  // cwd/.qoder/settings.local.json, parent). Each is a separate SFTP lstat round-trip
  // (~300ms). Batch into one `stat -c` command (~1 RTT). stat -c is GNU coreutils —
  // present on virtually all real Linux remotes; if missing, falls back to per-path lstat.
  const PREFETCH_STAT_PATHS = [_cwd, _cwd + "/.qoder", _cwd + "/.qoder/settings.local.json", _parent];
  const PREFETCH_STAT_SET = new Set(PREFETCH_STAT_PATHS);
  let _statPrefetched = false;
  let _statPrintfOk = null; // null=untested, true/false after first attempt
  function prefetchStartupStat() {
    if (_statPrefetched) return;
    _statPrefetched = true;
    if (_statPrintfOk === false) return; // remote lacks stat -c, skip
    // %n=name %F=type %s=size %Y=mtime %X=atime %Z=ctime %a=perm %u=uid %g=gid
    const args = PREFETCH_STAT_PATHS.map((p) => JSON.stringify(p)).join(" ");
    const cmd = "stat -c '%n|%F|%s|%Y|%X|%Z|%a|%u|%g' " + args + " 2>/dev/null";
    const _t = Date.now();
    try {
      const r = sftp.sftpExec(cmd);
      const out = r.stdout.toString("utf8").trim();
      if (!out || r.exitCode !== 0) {
        _statPrintfOk = false;
        process.stderr.write("[launcher] stat -c unavailable, falling back to per-path lstat\n");
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
      process.stderr.write("[launcher] startup stat prefetch: " + PREFETCH_STAT_PATHS.length + " paths in " + (Date.now()-_t) + "ms\n");
    } catch (e) {
      _statPrintfOk = false;
      process.stderr.write("[launcher] startup stat prefetch FAILED: " + e.message + "\n");
    }
  }

  function sStat(p) {
    const c = cGet("stat", p);
    if (c) return c;
    // Batch prefetch: on first lstat of a known startup path, fetch all via one stat -c.
    if (PREFETCH_STAT_SET.has(p)) {
      prefetchStartupStat();
      const cached = cGet("stat", p);
      if (cached) {
        process.stderr.write("[launcher] fs.lstat " + p + " -> (prefetch cache)\n");
        return cached;
      }
    }
    const _t = Date.now();
    const r = JSON.parse(sftpCall(OP.lstat, p).toString("utf8"));
    process.stderr.write("[launcher] fs.lstat " + p + " -> " + (Date.now()-_t) + "ms\n");
    cSet("stat", p, r);
    return r;
  }
  function sExists(p) {
    const c = cGet("exists", p);
    if (c !== undefined) return c;
    // Disk-persisted probe cache: container/WSL existence checks are stable.
    if (PROBE_EXISTS.has(p) && diskCache.exists[p] !== undefined) {
      return diskCache.exists[p];
    }
    // Batch prefetch: on first startup existsSync of a known probe path, synchronously
    // fetch ALL probe paths in one exec command. Fills cache for the rest.
    if (PREFETCH_SET.has(p)) {
      prefetchStartupExists();
      const cached = cGet("exists", p);
      if (cached !== undefined) {
        process.stderr.write("[launcher] fs.exists " + p + " -> (prefetch cache) " + cached + "\n");
        return cached;
      }
    }
    const _t = Date.now();
    const r = JSON.parse(sftpCall(OP.exists, p).toString("utf8")).exists;
    process.stderr.write("[launcher] fs.exists " + p + " -> " + (Date.now()-_t) + "ms\n");
    cSet("exists", p, r);
    if (PROBE_EXISTS.has(p)) {
      diskCache.exists[p] = r;
      diskDirty = true;
      scheduleFlush();
    }
    return r;
  }
  function eexist(path) {
    const e = new Error("EEXIST: file already exists, copyFile '" + path + "'");
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

  // ===== Capture originals =====
  const O = {};
  for (const k of [
    "existsSync", "statSync", "lstatSync", "readFileSync", "writeFileSync",
    "readdirSync", "mkdirSync", "unlinkSync", "accessSync", "renameSync",
    "rmSync", "copyFileSync", "appendFileSync", "realpathSync", "rmdirSync",
    "createReadStream", "createWriteStream", "watch", "watchFile",
    "readFile", "writeFile", "stat", "lstat", "readdir", "access", "mkdir",
    "unlink", "rename", "copyFile", "appendFile", "rm", "realpath",
    "open", "write", "close", "read", "fstat", "ftruncate", "fsync",
    "fchmod", "fchown", "futimes", "chown", "chmod", "utimes", "link",
    "symlink", "readlink", "truncate", "opendir", "cp",
  ]) {
    O[k] = fs[k];
  }

  // ===== fs sync patches =====
  fs.existsSync = (p) => (isRemote(p) ? sExists(toRemote(p)) : O.existsSync.call(fs, p));
  fs.statSync = (p, opts) => (isRemote(p) ? makeStat(toRemote(p)) : O.statSync.call(fs, p, opts));
  fs.lstatSync = (p, opts) => (isRemote(p) ? makeStat(toRemote(p)) : O.lstatSync.call(fs, p, opts));
  fs.readFileSync = (p, opts) => {
    if (isRemote(p)) {
      const b = sRead(toRemote(p));
      const enc = typeof opts === "string" ? opts : opts && opts.encoding;
      return enc ? b.toString(enc) : b;
    }
    return O.readFileSync.call(fs, p, opts);
  };
  fs.writeFileSync = (p, d, opts) => {
    if (isRemote(p)) {
      sWrite(toRemote(p), d);
      return;
    }
    return O.writeFileSync.call(fs, p, d, opts);
  };
  // Dirent-compatible object for {withFileTypes: true} readdir calls.
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
        // ssh2's sftp.mkdir recursive mode is unreliable. Use `mkdir -p` via exec.
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
        const e = new Error("ENOENT: '" + p + "'");
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
      sftpCall(OP.unlink, toRemote(p));
      cInv(toRemote(p));
      return;
    }
    return O.rmSync.call(fs, p, opts);
  };
  fs.copyFileSync = (s, d, mode) => {
    const sRem = isRemote(s);
    const dRem = isRemote(d);
    // COPYFILE_EXCL: fail with EEXIST if destination exists. qoder's createBackup
    // uses this — ignoring it silently overwrites, which breaks version tracking.
    const excl = mode && (mode & 1) === 1; // COPYFILE_EXCL = 1
    if (sRem && dRem) {
      if (excl && sExists(toRemote(d))) throw eexist(d);
      sWrite(toRemote(d), sRead(toRemote(s)));
      return;
    }
    if (sRem && !dRem) {
      // remote source → local destination (e.g. qoder file-history backup of a remote file)
      if (excl && O.existsSync.call(fs, d)) throw eexist(d);
      // Ensure parent dir exists — qoder's createBackup assumes the dest dir is there,
      // but on first run file-history/... may not exist yet. writeFileSync won't create it.
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
  // Preserve .native — Node.js libs (graceful-fs, qoder internals) call
  // fs.realpathSync.native directly. The arrow-function replacement loses the
  // original .native binding, leaving it undefined → "not a function" or
  // worktree realpath failures. Point it back to the patched function so ALL
  // realpath calls (including .native) route remote paths correctly.
  Object.defineProperty(fs.realpathSync, "native", {
    value: fs.realpathSync,
    writable: false,
    configurable: false,
  });
  // readlink/symlink — remote paths need SFTP, not native Windows calls.
  if (!O.readlinkSync) O.readlinkSync = fs.readlinkSync;
  fs.readlinkSync = (p, opts) => {
    if (isRemote(p)) {
      const r = sftpExec("readlink -f " + JSON.stringify(toRemote(p)));
      return r.stdout.toString("utf8").trim() || toRemote(p);
    }
    return O.readlinkSync.call(fs, p, opts);
  };
  if (!O.symlinkSync) O.symlinkSync = fs.symlinkSync;
  fs.symlinkSync = (target, path) => {
    if (isRemote(path) || isRemote(target)) {
      sftpExec("ln -sf " + JSON.stringify(toRemote(target)) + " " + JSON.stringify(toRemote(path)));
      return;
    }
    return O.symlinkSync.call(fs, target, path);
  };
  fs.rmdirSync = (p, opts) => {
    if (isRemote(p)) {
      sftpCall(OP.rmdir, toRemote(p));
      cInv(toRemote(p));
      return;
    }
    return O.rmdirSync.call(fs, p, opts);
  };

  // ===== fd-based writes (openSync + writeSync + closeSync) =====
  // For remote paths, return a synthetic fd tracked in a map. Writes buffer in memory and
  // flush via sWrite on close. qoder's Write tool uses this pattern.
  const _fdMap = new Map();
  let _nextFd = 1000;
  if (!O.openSync) O.openSync = fs.openSync;
  fs.openSync = function (p, flags, mode) {
    if (isRemote(p)) {
      const fd = _nextFd++;
      _fdMap.set(fd, { path: toRemote(p), flags: String(flags || ""), chunks: [] });
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

  // Lock patched methods via getter/setter so graceful-fs cannot clobber them by assignment.
  const _locked = {};
  const lockMethod = (name) => {
    _locked[name] = fs[name];
    try {
      Object.defineProperty(fs, name, {
        get: () => _locked[name],
        set: () => {},
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
    "readlinkSync", "symlinkSync",
  ]) {
    lockMethod(name);
  }

  // ===== fs async =====
  // wrapAsync wraps a SYNC remote op, but for LOCAL paths it MUST delegate to the original
  // async function so callback-style callers (e.g. proper-lockfile's graceful-fs, which calls
  // fs.mkdir(path, cb) / fs.stat(path, cb)) get their callback invoked. Routing local
  // callback calls through the sync function left the callback uninvoked → proper-lockfile's
  // credential-lock never settled → qoder hung after auth.
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
  if (O.symlink) fs.symlink = wrapAsync((target, path) => { fs.symlinkSync(target, path); return undefined; }, O.symlink);
  fs.exists = (p, cb) => {
    if (typeof cb === "function") {
      process.nextTick(() => cb(isRemote(p) ? sExists(toRemote(p)) : O.existsSync.call(fs, p)));
      return;
    }
    return isRemote(p) ? sExists(toRemote(p)) : O.existsSync.call(fs, p);
  };

  // ===== fs.promises =====
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
            const e = new Error("EEXIST: file already exists, open '" + p + "'");
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
  P.symlink = (target, path) => new Promise((res, rej) => { try { fs.symlinkSync(target, path); res(); } catch (e) { rej(e); } });
  P.readdir = (p, opts) => new Promise((res, rej) => {
    try { res(fs.readdirSync(p, opts)); } catch (e) {
      // EnterWorktree's u2i() calls readdir on the worktree path before creating it.
      // It catches ENOENT, but the lock assertHeld after that fails — the flow never
      // reaches vcl() which calls mkdir + git worktree add. Returning [] instead of
      // throwing ENOENT lets the flow proceed to the creation step.
      if (e.code === "ENOENT" && String(p||"").includes("/.qoder/worktrees/")) {
        res([]);
        return;
      }
      rej(e);
    }
  });

  // Copy any original promises methods we didn't override (e.g. opendir, link, symlink...).
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
    process.stderr.write("[launcher] fsp in-place mutate failed: " + e.message + "\n");
  }
  try {
    Object.defineProperty(fs, "promises", { value: realFsp, configurable: true, writable: true });
  } catch (e) {}
  global.__REMOTE_PROMISES__ = realFsp;

  // Lock fs.promises property + fsp methods against graceful-fs clobbering.
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

  // ===== Streams & watch =====
  fs.createReadStream = (p, opts) => {
    if (isRemote(p)) {
      const d = sRead(toRemote(p));
      const s = new Readable({ read() {} });
      s.push(d);
      s.push(null);
      return s;
    }
    return O.createReadStream.call(fs, p, opts);
  };
  fs.createWriteStream = (p, opts) => {
    if (isRemote(p)) {
      const rp = toRemote(p);
      const ch = [];
      const s = new Writable({ write(c, e, d) { ch.push(c); d(); } });
      s.on("finish", () => sWrite(rp, Buffer.concat(ch)));
      return s;
    }
    return O.createWriteStream.call(fs, p, opts);
  };
  fs.watch = (p, opts, cb) => {
    if (isRemote(p)) {
      const w = new EventEmitter();
      w.close = () => {};
      return w;
    }
    return O.watch.call(fs, p, opts, cb);
  };
  fs.watchFile = (p, opts, cb) => {
    if (isRemote(p)) return;
    return O.watchFile.call(fs, p, opts, cb);
  };

  // ===== Fake PTY + Module._load interception =====
  function FakeTerminal(program, args, options) {
    const child = cp.spawn(program, args, options || {});
    const dh = new Set();
    const eh = new Set();
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => dh.forEach((h) => h(d)));
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => dh.forEach((h) => h(d)));
    }
    child.on("error", () => eh.forEach((h) => h({ exitCode: 1, signal: 0 })));
    child.on("exit", (code, signal) =>
      eh.forEach((h) => h({ exitCode: code ?? 0, signal: typeof signal === "string" ? 1 : 0 }))
    );
    this.pid = child.pid ?? -1;
    this._child = child;
    this.onData = (cb) => { dh.add(cb); return { dispose: () => dh.delete(cb) }; };
    this.onExit = (cb) => { eh.add(cb); return { dispose: () => eh.delete(cb) }; };
    this.write = (data) => { try { child.stdin.write(data); } catch (e) {} };
    this.resize = () => {};
    this.kill = (signal) => { try { child.kill(signal); } catch (e) {} };
  }
  const fakePty = {
    spawn: (p, a, o) => new FakeTerminal(p, a, o),
    WindowsTerminal: FakeTerminal,
    UnixTerminal: FakeTerminal,
  };

  const _load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (typeof request === "string" && (request === "@lydell/node-pty" || request.includes("node-pty"))) {
      return fakePty;
    }
    if (request === "fs/promises" || request === "node:fs/promises") {
      return global.__REMOTE_PROMISES__ || fs.promises;
    }
    return _load.call(this, request, parent, isMain);
  };

  // ===== Async probe refresh (background, non-blocking) =====
  // Called after SFTP worker ready (from index.js). Re-fetches environment probe values
  // via sftpExecAsync (dedicated ssh2 channels, does NOT block the main thread) and
  // updates the disk cache for NEXT launch. Current launch already used the cached
  // values for fast startup; this just keeps them fresh. Failure is silent — stale
  // cache is acceptable (worst case: next launch re-fetches).
  let _refreshed = false;
  async function refreshProbesAsync() {
    if (_refreshed || !sftp.sftpExecAsync) return;
    _refreshed = true;
    try {
      // Read probe files via cat (async exec channel, no main-thread block).
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
      // Existence probes via test -f (async).
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
      await Promise.all([...readPromises, ...existPromises]);
      flushDiskCache();
      process.stderr.write("[launcher] probe cache: async refresh done\n");
    } catch (e) {
      // Silent failure — stale cache is fine.
    }
  }

  return { refreshProbesAsync, prefetchStartupExists };
}

module.exports = { apply };
