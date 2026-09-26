const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const netBlock = require("../../lib/core/net-block");

// Each test installs with a path list; since install patches http/https in place and
// node --test runs each file in its own process, this is isolated. We verify both the
// blocked path (synthetic response) and a non-blocked path still works end-to-end via
// a real loopback server.

function blockedResponse(req) {
  return new Promise((res) => {
    const chunks = [];
    req.on("response", (r) => {
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => res({ statusCode: r.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.end();
  });
}

test("blocked OTLP path returns synthetic 200, no socket opened", async () => {
  netBlock.install(["/v1/traces", "/v1/logs", "/v1/metrics"]);
  const req = http.request({
    hostname: "api2.qoder.sh",
    path: "/v1/traces",
    method: "POST",
  });
  const r = await blockedResponse(req);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, "");
});

test("blocked path via URL string form is intercepted", async () => {
  netBlock.install(["/v1/logs"]);
  const req = http.request("http://api2.qoder.sh/v1/logs");
  const r = await blockedResponse(req);
  assert.equal(r.statusCode, 200);
});

test("blocked path via URL object form is intercepted", async () => {
  netBlock.install(["/v1/metrics"]);
  const req = http.request(new URL("https://api2.qoder.sh/v1/metrics"));
  // https path — synthetic request should still work without a real TLS handshake
  const r = await blockedResponse(req);
  assert.equal(r.statusCode, 200);
});

test("non-blocked path still reaches a real server (login path untouched)", async () => {
  netBlock.install(["/v1/traces", "/v1/logs", "/v1/metrics"]);
  // Spin up a real loopback server and confirm /api/v1/userinfo is NOT intercepted.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("real-" + req.url);
  });
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  try {
    const r = await blockedResponse(http.request({
      hostname: "127.0.0.1",
      port,
      path: "/api/v1/userinfo",
      method: "GET",
    }));
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, "real-/api/v1/userinfo");
  } finally {
    server.close();
  }
});

test("blocked path with query string is still matched", async () => {
  netBlock.install(["/v1/traces"]);
  const req = http.request({ hostname: "api2.qoder.sh", path: "/v1/traces?foo=bar", method: "POST" });
  const r = await blockedResponse(req);
  assert.equal(r.statusCode, 200);
});

test("install with empty path list is a no-op (no patching)", () => {
  // Should not throw and should not patch (returns early).
  assert.doesNotThrow(() => netBlock.install([]));
  assert.doesNotThrow(() => netBlock.install(null));
});
