const test = require("node:test");
const assert = require("node:assert/strict");
const { isRemote, toRemote, isLocal } = require("../../lib/classifier");

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
