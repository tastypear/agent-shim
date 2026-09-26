const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { create: createMockSftp } = require("./mock-sftp");
const bridgeMod = require("../../lib/fs-bridge");

// Install the bridge ONCE at module load with a shared in-memory mock SFTP — the
// same wiring the preload uses. lockMethod makes the patched fs methods
// non-configurable, so re-installing per test would silently no-op (production
// installs once, so that's fine there). Tests set up state through the patched fs.
// node --test runs each file in its own process, so patching the global fs here
// is isolated from other test files.
const _sftp = createMockSftp({});
const _cacheFile = path.join(os.tmpdir(), "as-fdtest-" + Math.random().toString(36).slice(2) + ".json");
try { fs.unlinkSync(_cacheFile); } catch (e) {}
bridgeMod.apply(_sftp, () => "/root", {
  host: "test", cacheFile: _cacheFile, cacheDir: os.tmpdir(),
}, {
  getPrefetchPaths: () => ({ exists: [], stat: [] }),
  needsOsReleaseFake: () => false,
}, {});

test("atomic write via virtual fd: open/write/fsync/fdatasync/close lands content on remote", () => {
  const p = "/root/cfg.json";
  const fd = fs.openSync(p, "w");
  assert.equal(typeof fd, "number");
  assert.ok(fd >= 1000, "virtual fd >= 1000");
  fs.writeFileSync(fd, '{"k":1}');
  // These previously threw EBADF on the virtual fd — must no-op now.
  assert.equal(fs.fsyncSync(fd), undefined);
  assert.equal(fs.fdatasyncSync(fd), undefined);
  fs.closeSync(fd);
  assert.equal(fs.readFileSync(p).toString(), '{"k":1}');
});

test("fstatSync on a virtual fd returns a stat for the remote path", () => {
  fs.writeFileSync("/root/exist.txt", "hello"); // setup via patched fs (routes to mock)
  const fd = fs.openSync("/root/exist.txt", "r");
  const st = fs.fstatSync(fd);
  assert.equal(st.size, 5);
  assert.equal(st.isFile(), true);
  fs.closeSync(fd);
});

test("ftruncateSync on a virtual fd does not throw and truncates pending writes", () => {
  const p = "/root/trunc.txt";
  const fd = fs.openSync(p, "w");
  fs.writeFileSync(fd, "hello world");
  fs.ftruncateSync(fd, 5);
  fs.closeSync(fd);
  assert.equal(fs.readFileSync(p).toString(), "hello");
});

test("fd-based ops pass through to native for real local fds (no EBADF)", () => {
  const tmp = path.join(os.tmpdir(), "as-real-fd-" + Math.random().toString(36).slice(2) + ".txt");
  const fd = fs.openSync(tmp, "w"); // real native fd (local path)
  assert.ok(fd < 1000, "real fd is small");
  fs.writeFileSync(fd, "native");
  fs.fsyncSync(fd); // native passthrough — must not throw
  fs.fdatasyncSync(fd);
  const st = fs.fstatSync(fd);
  assert.equal(st.isFile(), true);
  fs.closeSync(fd);
  assert.equal(fs.readFileSync(tmp, "utf8"), "native");
  try { fs.unlinkSync(tmp); } catch (e) {}
});
