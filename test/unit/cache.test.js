const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { isRemote, toRemote } = require("../../lib/classifier");
const { create: createMockSftp, OP } = require("./mock-sftp");
const cacheMod = require("../../lib/fs-bridge/cache");

// Fresh installed cache per test: mock SFTP, minimal adapter.
function freshCache(initialFiles) {
  const sftp = createMockSftp(initialFiles);
  let calls = 0;
  const wrappedSftpCall = (op, p, d, x) => { calls++; return sftp.sftpCall(op, p, d, x); };
  const cfg = { host: "test" };
  const adapter = {
    getPrefetchPaths: () => ({ exists: [], stat: [], read: [], readdir: [], access: [] }),
    needsOsReleaseFake: () => false,
  };
  const ctx = {
    fs, isRemote, toRemote,
    sftpCall: wrappedSftpCall, sftpExec: sftp.sftpExec, OP, sftp,
    getRemoteCwd: () => "/root", cfg, adapter, probes: {},
  };
  cacheMod.install(ctx);
  return { ctx, calls: () => calls };
}

test("sRead caches within TTL (second call hits cache, no sftpCall)", () => {
  const { ctx, calls } = freshCache({ "/root/f.txt": "hello" });
  const a = ctx.sRead("/root/f.txt");
  assert.equal(a.toString(), "hello");
  assert.equal(calls(), 1);
  const b = ctx.sRead("/root/f.txt");
  assert.equal(b.toString(), "hello");
  assert.equal(calls(), 1); // cache hit — no new sftpCall
});

test("sWrite invalidates the read cache for that path", () => {
  const { ctx, calls } = freshCache({ "/root/f.txt": "v1" });
  ctx.sRead("/root/f.txt");
  assert.equal(calls(), 1);
  ctx.sWrite("/root/f.txt", "v2"); // writeFile itself is one sftpCall
  assert.equal(calls(), 2);
  const b = ctx.sRead("/root/f.txt");
  assert.equal(b.toString(), "v2");
  assert.equal(calls(), 3); // invalidated → re-fetched
});

test("sExists returns true/false and caches", () => {
  const { ctx, calls } = freshCache({ "/root/exists.txt": "x" });
  assert.equal(ctx.sExists("/root/exists.txt"), true);
  assert.equal(ctx.sExists("/root/nope.txt"), false);
  assert.equal(calls(), 2);
  // second round hits cache
  assert.equal(ctx.sExists("/root/exists.txt"), true);
  assert.equal(ctx.sExists("/root/nope.txt"), false);
  assert.equal(calls(), 2);
});

test("sStat returns a stat object with isFile/isDirectory", () => {
  const { ctx } = freshCache({ "/root/f.txt": "data" });
  const st = ctx.sStat("/root/f.txt");
  assert.equal(st.isFile, true);
  assert.equal(st.isDirectory, false);
  assert.equal(st.size, 4);
});

test("sReaddir lists directory entries", () => {
  const { ctx } = freshCache({});
  const sftp = ctx.sftp;
  sftp.sftpCall(OP.mkdir, "/root/dir");
  sftp.sftpCall(OP.writeFile, "/root/dir/a.txt", "1");
  sftp.sftpCall(OP.writeFile, "/root/dir/b.txt", "2");
  const entries = ctx.sReaddir("/root/dir");
  assert.ok(entries.length >= 2);
  assert.ok(entries.some((e) => e.n === "a.txt"));
});

test("sRead throws ENOENT for missing files", () => {
  const { ctx } = freshCache({});
  assert.throws(() => ctx.sRead("/root/missing.txt"), /ENOENT/);
});
