// lib/http-exec.js
// Thin HTTP exec wrapper for agent-shim's exec-bridge.
// Provides sftpExec (sync) and sftpExecAsync (async) via remote-ops-server's
// /api/exec endpoint. fs operations are handled by remote-fs-node directly;
// this module only covers command execution.

const http = require("http");
const https = require("https");

function create(cfg) {
  const token = cfg.token;
  const tls = cfg.tls || false;
  const port = cfg.port || 8765;
  const host = cfg.host;
  const lib = tls ? https : http;
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const baseURL = (tls ? "https://" : "http://") + (host.includes(":") ? "[" + host + "]" : host) + ":" + port;

  function sftpExec(cmd) {
    const bridge = require("remote-fs-node").syncBridge;
    if (bridge && bridge.isAvailable()) {
      const body = Buffer.from(JSON.stringify({ cmd, shell: true }), "utf8");
      const result = bridge.syncRequest(1, "/api/exec", body); // 1 = POST
      if (result && result.statusCode === 200) {
        const r = JSON.parse(result.body.toString("utf8"));
        return {
          stdout: Buffer.from(r.stdout || ""),
          stderr: Buffer.from(r.stderr || ""),
          exitCode: r.exit_code ?? 0,
        };
      }
    }
    throw new Error("sync exec unavailable (worker bridge not ready) for: " + cmd.slice(0, 80));
  }

  function sftpExecAsync(cmd) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ cmd, shell: true });
      const req = lib.request({ hostname: host, port, path: "/api/exec", method: "POST", headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const r = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve({
              stdout: Buffer.from(r.stdout || ""),
              stderr: Buffer.from(r.stderr || ""),
              exitCode: r.exit_code ?? 0,
            });
          } catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  return { sftpExec, sftpExecAsync };
}

module.exports = { create };
