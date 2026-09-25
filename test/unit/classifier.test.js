const test = require("node:test");
const assert = require("node:assert/strict");
const { isRemote, toRemote, isLocal, hasWorkspacePrefix, makeVirtualCwd } = require("../../lib/classifier");

test("isRemote: posix-absolute drive-less paths are remote", () => {
  assert.equal(isRemote("/root"), true);
  assert.equal(isRemote("/home/user/file.txt"), true);
  assert.equal(isRemote("/etc/os-release"), true);
});

test("isRemote: drive-qualified Windows paths are NOT remote", () => {
  assert.equal(isRemote("C:\\Users\\foo"), false);
  assert.equal(isRemote("C:/Users/foo"), false);
  assert.equal(isRemote("D:\\program"), false);
});

test("isRemote: MSYS/git-bash drive forms (/c/, /d/) are NOT remote", () => {
  // local bash pwd produces these; without the rule they'd be mistaken for remote posix paths
  assert.equal(isRemote("/c/Users/tastypear"), false);
  assert.equal(isRemote("/c/Users/tastypear/AppData/Roaming/npm/node_modules"), false);
  assert.equal(isRemote("/d/program/agent-shim"), false);
  assert.equal(isRemote("/z/foo"), false);
});

test("isRemote: multi-letter posix roots ARE still remote (not confused with MSYS drives)", () => {
  assert.equal(isRemote("/root"), true);
  assert.equal(isRemote("/home/user"), true);
  assert.equal(isRemote("/etc/os-release"), true);
  assert.equal(isRemote("/usr/bin/bash"), true);
  assert.equal(isRemote("/proc/version"), true);
  assert.equal(isRemote("/var/log"), true);
  assert.equal(isRemote("/opt/app"), true);
});

test("isRemote: relative and bare names are not remote", () => {
  assert.equal(isRemote("foo.txt"), false);
  assert.equal(isRemote("./foo"), false);
  assert.equal(isRemote("../bar"), false);
  assert.equal(isRemote("bash"), false);
});

test("isRemote: backslash posix paths normalize to remote", () => {
  // /root\\foo normalizes to /root/foo — still drive-less posix-absolute
  assert.equal(isRemote("/root\\foo"), true);
});

test("toRemote: normalizes slashes and drops a stray drive", () => {
  assert.equal(toRemote("/root/foo"), "/root/foo");
  assert.equal(toRemote("/root\\foo"), "/root/foo");
  assert.equal(toRemote("C:/root/foo"), "/root/foo");
  assert.equal(toRemote("C:\\root\\foo"), "/root/foo");
});

test("isLocal is the inverse of isRemote", () => {
  assert.equal(isLocal("/root"), false);
  assert.equal(isLocal("C:\\Users"), true);
  assert.equal(isLocal("bash"), true);
});

// ===== Virtual workspace prefix /__box/<id>/ =====

test("isRemote: virtual workspace paths ARE remote (posix-absolute, drive-less)", () => {
  assert.equal(isRemote("/__box/a1b2c3d4e5f6/root"), true);
  assert.equal(isRemote("/__box/abc123def456/home/me/proj"), true);
});

test("hasWorkspacePrefix: detects /__box/<hex12>/", () => {
  assert.equal(hasWorkspacePrefix("/__box/a1b2c3d4e5f6/root"), true);
  assert.equal(hasWorkspacePrefix("/__box/a1b2c3d4e5f6/"), true);
  assert.equal(hasWorkspacePrefix("/root"), false);
  assert.equal(hasWorkspacePrefix("/__box/short/root"), false);       // id too short
  assert.equal(hasWorkspacePrefix("/__box/Z1b2c3d4e5f6/root"), false); // non-hex id
  assert.equal(hasWorkspacePrefix("/__boxroot"), false);
});

test("toRemote: strips /__box/<id>/ prefix, keeps the real path posix-absolute", () => {
  assert.equal(toRemote("/__box/a1b2c3d4e5f6/root"), "/root");
  assert.equal(toRemote("/__box/abc123def456/home/me/foo.js"), "/home/me/foo.js");
  assert.equal(toRemote("/__box/a1b2c3d4e5f6/"), "/");
  assert.equal(toRemote("/__box/000000000000/etc/os-release"), "/etc/os-release");
});

test("toRemote: non-prefixed paths behave as before (slash + drive normalization)", () => {
  assert.equal(toRemote("/root/foo"), "/root/foo");
  assert.equal(toRemote("C:/root/foo"), "/root/foo");
});

test("makeVirtualCwd: builds /__box/<id>/<realvcwd>", () => {
  assert.equal(makeVirtualCwd("a1b2c3d4e5f6", "/root"), "/__box/a1b2c3d4e5f6/root");
  assert.equal(makeVirtualCwd("a1b2c3d4e5f6", "/home/me/proj"), "/__box/a1b2c3d4e5f6/home/me/proj");
  // relative vcwd gets a leading slash
  assert.equal(makeVirtualCwd("a1b2c3d4e5f6", "root"), "/__box/a1b2c3d4e5f6/root");
});

test("makeVirtualCwd + toRemote round-trip two distinct connections (session isolation)", () => {
  // Two remotes both exposing /root get distinct virtual cwds → distinct CB hashes,
  // but toRemote maps both back to the same real /root for fs/exec routing.
  const connA = makeVirtualCwd("a1b2c3d4e5f6", "/root");
  const connB = makeVirtualCwd("b2c3d4e5f6a1", "/root");
  assert.notEqual(connA, connB);
  assert.equal(toRemote(connA), "/root");
  assert.equal(toRemote(connB), "/root");
  assert.equal(toRemote(connA + "/.qoder/settings.json"), "/root/.qoder/settings.json");
});
