const test = require("node:test");
const assert = require("node:assert/strict");

// Load the path-bridge patch (idempotent: patches path module in place).
require("../../lib/path-bridge.js");
const path = require("path");

test("resolve: posix-absolute drive-less path stays posix", () => {
  assert.equal(path.resolve("/root/foo"), "/root/foo");
  assert.equal(path.resolve("/root", "sub", "file.txt"), "/root/sub/file.txt");
});

test("resolve: drive-qualified path uses win32", () => {
  assert.equal(path.resolve("C:\\Users\\foo"), "C:\\Users\\foo");
  assert.equal(path.resolve("C:\\a", "b"), "C:\\a\\b");
});

test("resolve: bare drive letter resolves to drive root (not cwd-hybrid)", () => {
  // Node's native fs.realpathSync internally calls path.resolve("C:") to resolve
  // "current dir on drive C". orig.resolve("C:") uses process.cwd() as the base;
  // when process.cwd() is a posix virtual prefix (/◦host∶port/root), win32.resolve
  // treats it as relative and produces a hybrid "C:\◦host∶port\root". A bare drive
  // letter must resolve to the drive root, independent of cwd.
  assert.equal(path.resolve("C:"), "C:\\");
  assert.equal(path.resolve("D:"), "D:\\");
  assert.equal(path.resolve("c:"), "C:\\");
});

test("join: posix drive-less args stay posix", () => {
  assert.equal(path.join("/root", ".qoder", "settings.json"), "/root/.qoder/settings.json");
});

test("join: drive-qualified arg uses win32", () => {
  assert.equal(path.join("C:\\Users", "foo"), "C:\\Users\\foo");
});

test("normalize: posix vs win32 routing", () => {
  assert.equal(path.normalize("/root/./foo"), "/root/foo");
  assert.equal(path.normalize("C:\\Users\\.\\foo"), "C:\\Users\\foo");
});

test("dirname/basename: posix routing for remote paths", () => {
  assert.equal(path.dirname("/root/sub/file.txt"), "/root/sub");
  assert.equal(path.basename("/root/sub/file.txt"), "file.txt");
});

test("isAbsolute: posix / is absolute, drive-qualified is absolute", () => {
  assert.equal(path.isAbsolute("/root"), true);
  assert.equal(path.isAbsolute("C:\\Users"), true);
  assert.equal(path.isAbsolute("relative/path"), false);
});
