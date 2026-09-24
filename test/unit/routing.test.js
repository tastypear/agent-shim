const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isBash, isRg, shellQuote, buildRgRemoteCmd, buildRemoteCmd, wrapSpawn, routeExecCommand,
} = require("../../lib/exec-bridge/routing");

const mockAdapter = {
  getLocalBash: () => "C:/qoder/bin/git/bin/bash.exe",
  isHostInternalCmd: (cmd) => cmd.includes("qodersec-launch") || cmd.includes("shell-snapshots"),
};
const getRemoteCwd = () => "/root";

test("isBash: recognizes bash/sh variants", () => {
  for (const b of ["bash", "sh", "bash.exe", "sh.exe", "/usr/bin/bash", "C:/git/bin/bash.exe"]) {
    assert.equal(isBash(b), true, b);
  }
  for (const n of ["rg", "node", "cmd.exe", ""]) {
    assert.equal(isBash(n), false, n);
  }
});

test("isRg: recognizes ripgrep", () => {
  assert.equal(isRg("rg"), true);
  assert.equal(isRg("rg.exe"), true);
  assert.equal(isRg("/usr/bin/rg"), true);
  assert.equal(isRg("bash"), false);
});

test("shellQuote: simple strings pass through, special chars get quoted", () => {
  assert.equal(shellQuote("simple"), "simple");
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("has space"), "'has space'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("buildRgRemoteCmd: cd then rg with quoted args", () => {
  const cmd = buildRgRemoteCmd(["pattern", "."], "/root");
  // /root has no shell-special chars, so shellQuote leaves it unquoted
  assert.equal(cmd, "cd /root && rg pattern .");
});

test("buildRgRemoteCmd: remote paths in args are normalized", () => {
  const cmd = buildRgRemoteCmd(["pat", "/root/sub"], "/root");
  assert.equal(cmd, "cd /root && rg pat /root/sub");
});

test("buildRemoteCmd: exe + args quoted", () => {
  assert.equal(buildRemoteCmd("grep", ["foo", "/root/f"]), "grep foo /root/f");
  assert.equal(buildRemoteCmd("git status", []), "'git status'");
});

test("wrapSpawn: rg with remote cwd routes to sftp exec", () => {
  const r = wrapSpawn("rg", ["pattern", "."], { cwd: "/root" }, mockAdapter, getRemoteCwd);
  assert.equal(r.exe, "__sftp_exec__");
  assert.match(r.args[0], /^cd \/root && rg pattern \.$/);
  assert.equal(r.opts.cwd, undefined);
});

test("wrapSpawn: bash -c with a generic command routes remote", () => {
  const r = wrapSpawn("bash", ["-c", "ls -la"], {}, mockAdapter, getRemoteCwd);
  assert.equal(r.exe, "__sftp_exec__");
  assert.equal(r.args[0], "cd '/root' && ls -la");
});

test("wrapSpawn: bash -c with host-internal command runs locally", () => {
  const cmd = "qodersec-launch --foo";
  const r = wrapSpawn("bash", ["-c", cmd], {}, mockAdapter, getRemoteCwd);
  assert.equal(r.exe, "C:/qoder/bin/git/bin/bash.exe");
  assert.deepEqual(r.args, ["-c", cmd]);
});

test("wrapSpawn: bash without -c runs locally with login flags stripped", () => {
  const r = wrapSpawn("bash", ["-l", "--login", "-i"], {}, mockAdapter, getRemoteCwd);
  assert.equal(r.exe, "C:/qoder/bin/git/bin/bash.exe");
  assert.deepEqual(r.args, []);
});

test("wrapSpawn: Windows exe with no remote cwd passes through (null)", () => {
  const r = wrapSpawn("node.exe", ["script.js"], {}, mockAdapter, getRemoteCwd);
  assert.equal(r, null);
});

test("wrapSpawn: null/missing exe returns null", () => {
  assert.equal(wrapSpawn(null, ["x"], {}, mockAdapter, getRemoteCwd), null);
  assert.equal(wrapSpawn("bash", null, {}, mockAdapter, getRemoteCwd), null);
});

test("wrapSpawn: bash -c eval '...' extracts the inner command", () => {
  const r = wrapSpawn("bash", ["-c", "eval 'git status'"], {}, mockAdapter, getRemoteCwd);
  assert.equal(r.exe, "__sftp_exec__");
  assert.equal(r.args[0], "cd '/root' && git status");
});

test("routeExecCommand: generic command wraps with cd remote", () => {
  assert.equal(routeExecCommand("ls -la", null, null, {}, mockAdapter, getRemoteCwd), "cd '/root' && ls -la");
});

test("routeExecCommand: host-internal command returns localBash marker", () => {
  const r = routeExecCommand("qodersec-launch --x", null, null, {}, mockAdapter, getRemoteCwd);
  assert.equal(r.__localBash, true);
  assert.equal(r.cmd, "qodersec-launch --x");
});

test("routeExecCommand: bash -c form routes remote", () => {
  const r = routeExecCommand(null, "bash", ["-c", "uname -a"], {}, mockAdapter, getRemoteCwd);
  assert.equal(r, "cd '/root' && uname -a");
});
