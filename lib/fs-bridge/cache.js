function install(ctx) {
  const { sftp, sftpCall, sftpExec, OP, fs, cfg, getRemoteCwd, adapter } = ctx;
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
  // Recursive cache invalidation: drop every cached entry whose key path is equal to or
  // nested under k. Used after `rm -rf <dir>` (a single remote exec that removes the whole
  // subtree) — cInv(k) alone would leave stale exists/stat/readdir entries for the children.
  const cInvTree = (k) => {
    const norm = String(k).replace(/\\/g, "/");
    const prefix = norm.endsWith("/") ? norm : norm + "/";
    for (const key of [...cache.keys()]) {
      const colon = key.indexOf(":");
      if (colon < 0) continue;
      const p = key.slice(colon + 1);
      if (p === norm || p.startsWith(prefix)) cache.delete(key);
    }
    cInv(norm);
  };
  ctx.cGet = cGet; ctx.cSet = cSet; ctx.cInv = cInv; ctx.cInvTree = cInvTree;

  function sRead(p) {
    const c = cGet("read", p);
    if (c !== undefined) {
      if (c instanceof Error) throw c;
      return c;
    }
    const _t = Date.now();
    try {
      const r = sftpCall(OP.readFile, p);
      logger.info("fs.readFile " + p + " -> " + (Date.now() - _t) + "ms");
      cSet("read", p, r);
      return r;
    } catch (err) {
      if (err && err.code === "ENOENT") cSet("read", p, err);
      throw err;
    }
  }
  function sWrite(p, d) {
    const _t = Date.now();
    sftpCall(OP.writeFile, p, Buffer.isBuffer(d) ? d : Buffer.from(String(d)));
    logger.info("fs.writeFile " + p + " -> " + (Date.now() - _t) + "ms");
    cInv(p);
  }
  function sReaddir(p) {
    const c = cGet("readdir", p);
    if (c !== undefined) {
      if (c instanceof Error) throw c;
      return c;
    }
    const _t = Date.now();
    try {
      const r = JSON.parse(sftpCall(OP.readdir, p).toString("utf8"));
      logger.info("fs.readdir " + p + " -> " + (Date.now() - _t) + "ms");
      cSet("readdir", p, r);
      return r;
    } catch (err) {
      if (err && err.code === "ENOENT") cSet("readdir", p, err);
      throw err;
    }
  }
  function sStat(p) {
    const c = cGet("stat", p);
    if (c) return c;
    const _t = Date.now();
    const r = JSON.parse(sftpCall(OP.lstat, p).toString("utf8"));
    logger.info("fs.lstat " + p + " -> " + (Date.now() - _t) + "ms");
    cSet("stat", p, r);
    return r;
  }
  function sExists(p) {
    const c = cGet("exists", p);
    if (c !== undefined) return c;
    const _t = Date.now();
    const r = JSON.parse(sftpCall(OP.exists, p).toString("utf8")).exists;
    logger.info("fs.exists " + p + " -> " + (Date.now() - _t) + "ms");
    cSet("exists", p, r);
    return r;
  }

  // ─── Startup batching ───────────────────────────────────────────────────
  // Batch all adapter prefetch paths (exists + access + stat + read + readdir)
  // via a few exec calls. Results injected into the TTL cache so subsequent fs
  // calls during init hit cache instead of making SFTP round-trips. Mirrors
  // http-cache.js prefetchStartup.
  let _prefetched = false;
  function prefetchStartup() {
    if (_prefetched) return 0;
    _prefetched = true;
    if (!adapter || !adapter.getPrefetchPaths) return 0;
    try {
      const cwd = getRemoteCwd();
      const parent = cwd.replace(/\/[^/]+$/, "") || "/";
      const pf = adapter.getPrefetchPaths(cwd, parent);
      if (!pf) return 0;
      let n = 0;
      const run = (cmd) => { try { return sftp.sftpExec(cmd); } catch (_) { return null; } };

      // ── exists + access batch: `test -e` per path, tagged output ──
      const existPaths = [...(pf.exists || []), ...(pf.access || [])];
      if (existPaths.length) {
        const tests = existPaths
          .map((p) => "if test -e " + JSON.stringify(p) + "; then printf '" + p + "\\t1\\n'; else printf '" + p + "\\t0\\n'; fi")
          .join(";");
        const r = run(tests);
        if (r) for (const line of r.stdout.toString("utf8").split("\n")) {
          const m = line.split("\t");
          if (m.length === 2) { cSet("exists", m[0], m[1] === "1"); n++; }
        }
      }

      // ── stat batch: `stat -c` for all paths → plain stat objects ──
      if (pf.stat && pf.stat.length) {
        const args = pf.stat.map((p) => JSON.stringify(p)).join(" ");
        const r = run("stat -c '%n|%F|%s|%Y|%X|%Z|%a|%u|%g' " + args + " 2>/dev/null");
        if (r) {
          const out = r.stdout.toString("utf8").trim();
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
            n++;
          }
        }
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
            if (f[2]) { cSet("read", f[1], Buffer.from(f[2], "base64")); n++; }
            else { cSet("read", f[1], _enoent(f[1])); n++; }
          }
        }
      }

      // ── readdir batch: `ls -1F` per dir, entries delimited by \037 (0x1f, POSIX octal) ──
      // \037 (octal) instead of \x1f: not all `tr` supports \x hex escapes (some treat
      // \x1f as literal "x"). ls -1F appends / @ * indicators; stripped after split.
      if (pf.readdir && pf.readdir.length) {
        const cmds = pf.readdir
          .map((p) => "printf 'L\\t" + p + "\\t'; ls -1F " + JSON.stringify(p) + " 2>/dev/null | tr '\\n' '\\037'; printf '\\n'")
          .join(";");
        const r = run(cmds);
        if (r) for (const line of r.stdout.toString("utf8").split("\n")) {
          const f = line.split("\t");
          if (f.length >= 3 && f[0] === "L") {
            if (f[2]) { cSet("readdir", f[1], f[2].split("\x1f").filter(Boolean).map((e) => e.replace(/[/@*]$/, ""))); n++; }
            else { cSet("readdir", f[1], _enoent(f[1])); n++; }
          }
        }
      }

      return n;
    } catch (e) {
      logger.info("startup prefetch FAILED: " + e.message);
      return 0;
    }
  }

  function _enoent(p) {
    const e = new Error("ENOENT: no such file or directory, '" + p + "'");
    e.code = "ENOENT"; e.errno = -2; e.path = p;
    return e;
  }

  Object.assign(ctx, {
    sRead, sWrite, sReaddir, sStat, sExists, prefetchStartup,
  });
}

module.exports = { install };