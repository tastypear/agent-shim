const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { expandHome, validate, mergeConfig } = require("../../lib/config");

test("expandHome: ~ resolves to homedir", () => {
  assert.equal(expandHome("~"), os.homedir());
  assert.equal(expandHome("~/foo"), path.join(os.homedir(), "foo"));
  assert.equal(expandHome("~\\bar"), path.join(os.homedir(), "bar"));
});

test("expandHome: non-home paths pass through", () => {
  assert.equal(expandHome("/abs/path"), "/abs/path");
  assert.equal(expandHome("relative"), "relative");
  assert.equal(expandHome(""), "");
  assert.equal(expandHome(undefined), undefined);
});

test("mergeConfig: user keys win within shared sections", () => {
  const defaults = { ssh: { port: 22, keyPath: "~/.ssh/id" }, keepalive: 5000 };
  const user = { ssh: { port: 2222, host: "h" } };
  const merged = mergeConfig(defaults, user);
  assert.equal(merged.ssh.port, 2222);
  assert.equal(merged.ssh.host, "h");
  assert.equal(merged.ssh.keyPath, "~/.ssh/id");
  assert.equal(merged.keepalive, 5000);
});

test("mergeConfig: user-only sections preserved", () => {
  const merged = mergeConfig({ ssh: { port: 22 } }, { env: { FOO: "1" } });
  assert.deepEqual(merged.env, { FOO: "1" });
  assert.equal(merged.ssh.port, 22);
});

test("validate: accepts a well-formed config without throwing", () => {
  assert.doesNotThrow(() =>
    validate({
      ssh: { host: "h", user: "u", port: 22, keyPath: "~/.ssh/id" },
      paths: { vcwd: "/root", osRelease: "6.5.0", home: "/root" },
      env: {},
      keepalive: 5000,
      readyTimeout: 15000,
    }, "test")
  );
});

test("validate: type mismatch throws", () => {
  assert.throws(() => validate({ ssh: { port: "notanumber" } }, "test"), /must be int/);
  assert.throws(() => validate({ ssh: "notobject" }, "test"), /must be an object/);
  assert.throws(() => validate({ keepalive: "abc" }, "test"), /must be int/);
});

test("validate: port as JSON number is accepted (int)", () => {
  assert.doesNotThrow(() => validate({ ssh: { port: 22 } }, "test"));
});

test("validate: unknown keys do not throw (warned)", () => {
  // Unknown keys warn via logger but must not throw — a typo shouldn't crash startup.
  assert.doesNotThrow(() => validate({ bogusKey: 1 }, "test"));
  assert.doesNotThrow(() => validate({ ssh: { bogus: 1 } }, "test"));
});
