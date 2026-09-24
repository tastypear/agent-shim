const test = require("node:test");
const assert = require("node:assert/strict");
const LOGGER_PATH = require.resolve("../../lib/logger");

function freshLogger(level) {
  delete require.cache[LOGGER_PATH];
  const had = Object.prototype.hasOwnProperty.call(process.env, "LOG_LEVEL");
  const old = process.env.LOG_LEVEL;
  if (level === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = level;
  delete process.env.LOG_FILE;
  const mod = require("../../lib/logger");
  if (had) process.env.LOG_LEVEL = old; else delete process.env.LOG_LEVEL;
  return mod;
}

function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { chunks.push(String(s)); return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return chunks.join("");
}

test("LEVELS: error < warn < info < debug < trace", () => {
  const { LEVELS } = freshLogger("info");
  assert.equal(LEVELS.error, 0);
  assert.equal(LEVELS.warn, 1);
  assert.equal(LEVELS.info, 2);
  assert.equal(LEVELS.debug, 3);
  assert.equal(LEVELS.trace, 4);
});

test("default level is info", () => {
  const log = freshLogger(undefined);
  assert.equal(log.isDebug(), false);
  assert.equal(log.isTrace(), false);
});

test("isDebug/isTrace reflect LOG_LEVEL", () => {
  assert.equal(freshLogger("debug").isDebug(), true);
  assert.equal(freshLogger("debug").isTrace(), false);
  assert.equal(freshLogger("trace").isDebug(), true);
  assert.equal(freshLogger("trace").isTrace(), true);
});

test("trace messages are filtered out at default (info) level", () => {
  const log = freshLogger(undefined);
  const c = log.child("mod");
  const out = captureStderr(() => {
    c.info("visible");
    c.trace("hidden");
  });
  assert.match(out, /visible/);
  assert.doesNotMatch(out, /hidden/);
});

test("trace messages appear at trace level", () => {
  const log = freshLogger("trace");
  const c = log.child("mod");
  const out = captureStderr(() => { c.trace("now-visible"); });
  assert.match(out, /now-visible/);
  assert.match(out, /\[TRACE\]/);
});

test("traceLazy skips formatting when below level", () => {
  const log = freshLogger("info");
  const c = log.child("mod");
  let called = false;
  const out = captureStderr(() => { c.traceLazy("x", () => { called = true; return { v: 1 }; }); });
  assert.equal(called, false);
  assert.equal(out, "");
});

test("traceLazy formats when at level", () => {
  const log = freshLogger("trace");
  const c = log.child("mod");
  const out = captureStderr(() => { c.traceLazy("x", () => ({ data: "payload" })); });
  assert.match(out, /payload/);
});

test("stdioDesc formats common stdio shapes", () => {
  const { stdioDesc } = freshLogger("info");
  assert.equal(stdioDesc(undefined), "none");
  assert.equal(stdioDesc({}), "undefined");
  assert.equal(stdioDesc({ stdio: "pipe" }), '"pipe"');
  assert.equal(stdioDesc({ stdio: ["pipe", "pipe", "pipe"] }), '["pipe","pipe","pipe"]');
  assert.equal(stdioDesc({ stdio: ["pipe", 6, 6] }), '["pipe",fd6,fd6]');
  assert.match(stdioDesc({ stdio: [{ constructor: { name: "Writable" } }] }), /Writable/);
});
