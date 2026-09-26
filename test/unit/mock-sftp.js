// test/unit/mock-sftp.js
// Map-based in-memory filesystem implementing the same sftpCall/sftpExec/sftpExecAsync
// interface as lib/sftp-client.js, returning the same data shapes as lib/sftp-worker.js.
// No SSH, no worker_threads — lets fs-bridge/cache/routing unit tests run offline.

const OP = {
  readFile: 0, writeFile: 1, lstat: 2, readdir: 3, exists: 4,
  mkdir: 5, unlink: 6, rename: 7, rmdir: 9, exec: 10,
};

// Entry: { type: "file"|"dir", content: Buffer, mtimeMs: number }
function create(initial) {
  const files = new Map();
  const now = Date.now();
  for (const [p, content] of Object.entries(initial || {})) {
    files.set(p, { type: "file", content: Buffer.from(content), mtimeMs: now });
  }

  function ensureDir(p) {
    if (!files.has(p)) files.set(p, { type: "dir", content: Buffer.alloc(0), mtimeMs: now });
  }

  function err(code, msg) {
    const e = new Error(msg || code);
    e.code = code;
    return e;
  }

  function statObj(entry) {
    return {
      size: entry.type === "file" ? entry.content.length : 0,
      mode: entry.type === "dir" ? 0o040755 : 0o100644,
      isFile: entry.type === "file",
      isDirectory: entry.type === "dir",
      isSymbolicLink: entry.type === "link",
      mtimeMs: entry.mtimeMs, ctimeMs: entry.mtimeMs, atimeMs: entry.mtimeMs,
      uid: 0, gid: 0, dev: 0, ino: 0, nlink: 1, rdev: 0, blksize: 4096, blocks: 0,
    };
  }

  function sftpCall(op, filePath, writeData, extraPath) {
    const p = String(filePath);
    switch (op) {
      case OP.readFile: {
        const e = files.get(p);
        if (!e || e.type !== "file") throw err("ENOENT", "ENOENT: '" + p + "'");
        return e.content;
      }
      case OP.writeFile: {
        const buf = Buffer.isBuffer(writeData) ? writeData : Buffer.from(String(writeData));
        files.set(p, { type: "file", content: buf, mtimeMs: Date.now() });
        return Buffer.alloc(0);
      }
      case OP.lstat: {
        const e = files.get(p);
        if (!e) throw err("ENOENT", "ENOENT: '" + p + "'");
        return Buffer.from(JSON.stringify(statObj(e)), "utf8");
      }
      case OP.readdir: {
        const e = files.get(p);
        if (!e || e.type !== "dir") throw err("ENOTDIR", "ENOTDIR: '" + p + "'");
        const entries = [];
        for (const [full, ent] of files) {
          const parent = full.replace(/\/[^/]+$/, "");
          if (parent === p && full !== p) {
            entries.push({ n: full.slice(p === "/" ? 1 : p.length + 1), f: ent.type === "file", d: ent.type === "dir", l: false });
          }
        }
        return Buffer.from(JSON.stringify(entries), "utf8");
      }
      case OP.exists: {
        return Buffer.from(JSON.stringify({ exists: files.has(p) }), "utf8");
      }
      case OP.mkdir: {
        files.set(p, { type: "dir", content: Buffer.alloc(0), mtimeMs: Date.now() });
        return Buffer.alloc(0);
      }
      case OP.unlink: {
        if (!files.has(p)) throw err("ENOENT", "ENOENT: '" + p + "'");
        files.delete(p);
        return Buffer.alloc(0);
      }
      case OP.rename: {
        const e = files.get(p);
        if (!e) throw err("ENOENT", "ENOENT: '" + p + "'");
        files.delete(p);
        files.set(String(extraPath), e);
        return Buffer.alloc(0);
      }
      case OP.rmdir: {
        const e = files.get(p);
        if (!e || e.type !== "dir") throw err("ENOTDIR", "ENOTDIR: '" + p + "'");
        files.delete(p);
        return Buffer.alloc(0);
      }
      default:
        throw err("EINVAL", "mock: unsupported op " + op);
    }
  }

  // Minimal shell for the probe/prefetch commands cache.js issues. Only the forms the
  // tests exercise; unknown commands return exit 0 / empty stdout.
  function runExec(command) {
    const cmd = String(command).trim();
    let m;
    if ((m = cmd.match(/^echo (.*)$/))) {
      return { stdout: Buffer.from(expandEnv(m[1]) + "\n"), stderr: Buffer.alloc(0), exitCode: 0 };
    }
    if ((m = cmd.match(/^uname -r$/))) {
      return { stdout: Buffer.from("6.5.0-14-generic\n"), stderr: Buffer.alloc(0), exitCode: 0 };
    }
    if ((m = cmd.match(/^mkdir -p (.*)$/))) {
      const p = unquote(m[1].trim());
      if (!files.has(p)) files.set(p, { type: "dir", content: Buffer.alloc(0), mtimeMs: Date.now() });
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    }
    if ((m = cmd.match(/^rm -rf (.*)$/))) {
      const target = unquote(m[1].trim());
      for (const k of [...files.keys()]) {
        if (k === target || k.startsWith(target + "/")) files.delete(k);
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    }
    if ((m = cmd.match(/^readlink (.*)$/))) {
      // Plain readlink (NOT -f): returns the link target, exits non-zero for non-symlinks
      // and missing paths — matching real `readlink` behavior the readlinkSync patch relies on.
      const p = unquote(m[1].trim());
      const e = files.get(p);
      if (e && e.type === "link") {
        return { stdout: Buffer.from(e.target + "\n"), stderr: Buffer.alloc(0), exitCode: 0 };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.from("readlink: " + p + ": Not a directory\n"), exitCode: 1 };
    }
    if ((m = cmd.match(/^cat (.*) 2>\/dev\/null \|\| true$/))) {
      const e = files.get(m[1].trim());
      return { stdout: e ? e.content : Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    }
    if ((m = cmd.match(/^test -e (.*) && echo y \|\| echo n$/))) {
      return { stdout: Buffer.from(files.has(m[1].trim()) ? "y" : "n"), stderr: Buffer.alloc(0), exitCode: 0 };
    }
    // prefetchStartupExists: "if test -e 'p'; then printf 'p\\t1\\n'; else printf 'p\\t0\\n'; fi;..."
    if (cmd.startsWith("if test -e ")) {
      const out = [];
      const re = /test -e '([^']+)'\s*;\s*then\s*printf\s*'([^\\]+)\\t1\\n'\s*;\s*else\s*printf\s*'([^\\]+)\\t0\\n'/g;
      let rm;
      while ((rm = re.exec(cmd))) {
        out.push(rm[1] + "\t" + (files.has(rm[1]) ? "1" : "0"));
      }
      return { stdout: Buffer.from(out.join("\n") + "\n"), stderr: Buffer.alloc(0), exitCode: 0 };
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
  }
  function expandEnv(s) {
    return s.replace(/\$HOME/g, "/root");
  }
  // Strip a single layer of double-quote shell quoting (JSON.stringify-style), so a
  // command like `mkdir -p "/root/tree"` stores the path as /root/tree, matching what
  // a real remote shell would pass to mkdir after removing the quotes.
  function unquote(s) {
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
    return s;
  }

  function sftpExec(command) { return runExec(command); }
  function sftpExecAsync(command) { return Promise.resolve(runExec(command)); }

  return { sftpCall, sftpExec, sftpExecAsync, OP, files };
}

module.exports = { create, OP };
