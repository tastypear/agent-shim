const test = require("node:test");
const assert = require("node:assert/strict");

// Load the path-bridge patch (idempotent: patches path module in place).
require("../../lib/path-bridge.js");
const path = require("path");
const { makeVirtualCwd } = require("../../lib/classifier");

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

// ===== Prefix stripping (tool-echo cleanliness) + session isolation =====
// qoder's projectIdentifier = CB(targetDir) = CB(path.resolve(process.cwd())). CB is a
// non-normalizing hash, so resolve(cwd) MUST keep the /◦host∶port/ prefix for two connections
// (same /root, different hosts) to bucket distinctly. But resolve(targetDir, "file.txt") must
// strip the prefix so tool echoes show clean remote paths. The patch distinguishes these by
// checking if the single arg is exactly process.cwd() (preserve) vs anything else (strip).

test("resolve: strips workspace prefix from multi-arg result", () => {
  const vcwd = makeVirtualCwd("127.0.0.1∶22", "/root");
  assert.equal(path.resolve(vcwd, "foo.txt"), "/root/foo.txt");
  assert.equal(path.resolve(vcwd, "sub", "file.txt"), "/root/sub/file.txt");
});

test("resolve: strips prefix from absolute path override", () => {
  const vcwd = makeVirtualCwd("127.0.0.1∶22", "/root");
  // absolute arg overrides cwd; prefix on cwd is irrelevant, result has no prefix
  assert.equal(path.resolve(vcwd, "/etc/passwd"), "/etc/passwd");
});

test("resolve: no-prefix posix path stays clean", () => {
  assert.equal(path.resolve("/root/foo"), "/root/foo");
  assert.equal(path.resolve("/root", "sub", "file.txt"), "/root/sub/file.txt");
});

test("relative: strips prefix from both sides", () => {
  const vcwd = makeVirtualCwd("127.0.0.1∶22", "/root");
  const resolved = path.resolve(vcwd, "foo.txt"); // already stripped -> /root/foo.txt
  assert.equal(path.relative(vcwd, resolved), "foo.txt");
  // both sides with prefix
  assert.equal(path.relative(vcwd, vcwd + "/bar.txt"), "bar.txt");
});

test("relative: no-prefix posix paths compute normally", () => {
  assert.equal(path.relative("/root", "/root/foo.txt"), "foo.txt");
  assert.equal(path.relative("/root", "/etc/passwd"), "../etc/passwd");
});

test("resolve: preserves prefix when resolving process.cwd() itself", () => {
  // Simulate qoder startup: process.cwd() returns the prefixed virtual cwd.
  // setTargetDir does path.resolve(process.cwd()) — this MUST keep the prefix so
  // CB(targetDir) buckets per-host.
  const realCwd = process.cwd;
  const vcwd = makeVirtualCwd("127.0.0.1∶22", "/root");
  try {
    process.cwd = () => vcwd;
    assert.equal(path.resolve(process.cwd()), vcwd);
  } finally {
    process.cwd = realCwd;
  }
});

test("session isolation: CB(resolve(cwd)) stays distinct across hosts (same /root)", () => {
  // CB = replace(/[^a-zA-Z0-9]/g, "-") — qoder's non-normalizing session-key hash.
  const realCwd = process.cwd;
  try {
    const vcwd1 = makeVirtualCwd("host1∶22", "/root");
    const vcwd2 = makeVirtualCwd("host2∶22", "/root");
    process.cwd = () => vcwd1;
    const t1 = path.resolve(process.cwd());
    process.cwd = () => vcwd2;
    const t2 = path.resolve(process.cwd());
    // targetDirs keep their prefixes → CB hashes differ
    assert.notEqual(t1, t2);
    assert.notEqual(t1.replace(/[^a-zA-Z0-9]/g, "-"), t2.replace(/[^a-zA-Z0-9]/g, "-"));
    // But tool-echo paths (multi-arg resolve) strip to the same clean /root
    process.cwd = () => vcwd1;
    assert.equal(path.resolve(process.cwd(), "foo.txt"), "/root/foo.txt");
    process.cwd = () => vcwd2;
    assert.equal(path.resolve(process.cwd(), "foo.txt"), "/root/foo.txt");
  } finally {
    process.cwd = realCwd;
  }
});

test("session isolation: resolvedPath is clean while targetDir is prefixed", () => {
  const realCwd = process.cwd;
  const vcwd = makeVirtualCwd("127.0.0.1∶22", "/root");
  try {
    process.cwd = () => vcwd;
    const targetDir = path.resolve(process.cwd()); // setTargetDir path — prefixed
    assert.ok(targetDir.includes("127.0.0.1"));
    const resolvedPath = path.resolve(targetDir, "iso_test.txt"); // tool echo — clean
    assert.equal(resolvedPath, "/root/iso_test.txt");
    assert.ok(!resolvedPath.includes("127.0.0.1"));
  } finally {
    process.cwd = realCwd;
  }
});

test("session isolation: process.cwd is not intercepted by path-bridge", () => {
  // path-bridge patches path.resolve/path.relative etc., but NOT process.cwd() itself
  // (that's platform.js's job). Whatever process.cwd() returns passes through untouched.
  const cwd = process.cwd();
  assert.equal(typeof process.cwd, "function");
  assert.equal(process.cwd(), cwd); // calling resolve doesn't mutate process.cwd()'s return
  path.resolve(cwd);
  assert.equal(process.cwd(), cwd);
});
