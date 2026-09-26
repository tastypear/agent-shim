const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { create: createMockSftp } = require("./mock-sftp");
const bridgeMod = require("../../lib/fs-bridge");

// Install the bridge ONCE at module load with a shared in-memory mock SFTP (same
// pattern as fd-ops.test.js — lockMethod makes the patched fs non-configurable,
// so re-installing per test would no-op). Tests set up state through the patched fs.
const _sftp = createMockSftp({});
const _cacheFile = path.join(os.tmpdir(), "as-readlink-test-" + Math.random().toString(36).slice(2) + ".json");
try { fs.unlinkSync(_cacheFile); } catch (e) {}
bridgeMod.apply(_sftp, () => "/root", {
  host: "test", cacheFile: _cacheFile, cacheDir: os.tmpdir(),
}, {
  getPrefetchPaths: () => ({ exists: [], stat: [] }),
  needsOsReleaseFake: () => false,
}, {});

test("readlinkSync on a symlink returns the link target", () => {
  // Set up a symlink entry directly in the mock's file map.
  _sftp.files.set("/root/link.txt", { type: "link", target: "/root/real.txt", content: Buffer.alloc(0), mtimeMs: Date.now() });
  _sftp.files.set("/root/real.txt", { type: "file", content: Buffer.from("hi"), mtimeMs: Date.now() });
  assert.equal(fs.readlinkSync("/root/link.txt"), "/root/real.txt");
});

test("readlinkSync on a regular file throws EINVAL (not returns a path)", () => {
  _sftp.files.set("/root/regular.txt", { type: "file", content: Buffer.from("data"), mtimeMs: Date.now() });
  // Previously readlink -f returned the path; now it must throw EINVAL to match native.
  try {
    fs.readlinkSync("/root/regular.txt");
    assert.fail("should have thrown EINVAL");
  } catch (e) {
    assert.equal(e.code, "EINVAL");
    assert.equal(e.errno, -22);
  }
});

test("readlinkSync on a directory throws EINVAL", () => {
  _sftp.files.set("/root/somedir", { type: "dir", content: Buffer.alloc(0), mtimeMs: Date.now() });
  try {
    fs.readlinkSync("/root/somedir");
    assert.fail("should have thrown EINVAL");
  } catch (e) {
    assert.equal(e.code, "EINVAL");
  }
});

test("readlinkSync on a non-existent path throws ENOENT", () => {
  try {
    fs.readlinkSync("/root/does-not-exist");
    assert.fail("should have thrown ENOENT");
  } catch (e) {
    assert.equal(e.code, "ENOENT");
  }
});

test("readlinkSync on a local path passes through to native", () => {
  // Local drive-qualified path → native readlinkSync. A regular local file should
  // throw EINVAL natively (or ENOENT if missing) — just confirm it doesn't route remote.
  const tmp = path.join(os.tmpdir(), "as-readlink-native-" + Math.random().toString(36).slice(2) + ".txt");
  fs.writeFileSync(tmp, "x");
  try {
    fs.readlinkSync(tmp);
    assert.fail("native readlinkSync on a regular file should throw");
  } catch (e) {
    assert.ok(e.code === "EINVAL" || e.code === "ENOENT", "native error, got " + e.code);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
});
