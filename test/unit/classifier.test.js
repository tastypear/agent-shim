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

// ===== Virtual workspace prefix /◦<host∶port>/ =====
// ◦ = U+25E6 (white bullet), ∶ = U+2236 (ratio, Windows-safe colon substitute)

const D = "\u25E6";   // ◦
const R = "\u2236";   // ∶

test("isRemote: virtual workspace paths ARE remote (posix-absolute, drive-less)", () => {
  assert.equal(isRemote("/" + D + "maigejb.com" + R + "22/root"), true);
  assert.equal(isRemote("/" + D + "127.0.0.1" + R + "22/home/me/proj"), true);
});

test("hasWorkspacePrefix: detects /◦<host∶port>/", () => {
  assert.equal(hasWorkspacePrefix("/" + D + "maigejb.com" + R + "22/root"), true);
  assert.equal(hasWorkspacePrefix("/" + D + "127.0.0.1" + R + "22/"), true);
  assert.equal(hasWorkspacePrefix("/root"), false);
  assert.equal(hasWorkspacePrefix("/" + D + "noport/root"), false);        // missing ∶port
  assert.equal(hasWorkspacePrefix("/" + D + "host" + R + "abc/root"), false); // port not digits
  assert.equal(hasWorkspacePrefix("/" + D + "root"), false);               // no slash after
});

test("toRemote: strips /◦<host∶port>/ prefix, keeps the real path posix-absolute", () => {
  assert.equal(toRemote("/" + D + "maigejb.com" + R + "22/root"), "/root");
  assert.equal(toRemote("/" + D + "127.0.0.1" + R + "22/home/me/foo.js"), "/home/me/foo.js");
  assert.equal(toRemote("/" + D + "maigejb.com" + R + "22/"), "/");
  assert.equal(toRemote("/" + D + "host.example.org" + R + "2222/etc/os-release"), "/etc/os-release");
});

test("toRemote: non-prefixed paths behave as before (slash + drive normalization)", () => {
  assert.equal(toRemote("/root/foo"), "/root/foo");
  assert.equal(toRemote("C:/root/foo"), "/root/foo");
});

test("makeVirtualCwd: builds /◦<id>/<realvcwd>", () => {
  assert.equal(makeVirtualCwd("maigejb.com" + R + "22", "/root"), "/" + D + "maigejb.com" + R + "22/root");
  assert.equal(makeVirtualCwd("127.0.0.1" + R + "22", "/home/me/proj"), "/" + D + "127.0.0.1" + R + "22/home/me/proj");
  // relative vcwd gets a leading slash
  assert.equal(makeVirtualCwd("maigejb.com" + R + "22", "root"), "/" + D + "maigejb.com" + R + "22/root");
});

test("makeVirtualCwd + toRemote round-trip two distinct connections (session isolation)", () => {
  // Two remotes both exposing /root get distinct virtual cwds → distinct CB hashes,
  // but toRemote maps both back to the same real /root for fs/exec routing.
  const connA = makeVirtualCwd("maigejb.com" + R + "22", "/root");
  const connB = makeVirtualCwd("127.0.0.1" + R + "22", "/root");
  assert.notEqual(connA, connB);
  assert.equal(toRemote(connA), "/root");
  assert.equal(toRemote(connB), "/root");
  assert.equal(toRemote(connA + "/.qoder/settings.json"), "/root/.qoder/settings.json");
});
