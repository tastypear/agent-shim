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
