// lib/http-exec.js
// Thin HTTP exec wrapper for agent-shim's exec-bridge.
// Provides sftpExec (sync) and sftpExecAsync (async) via remote-ops-server's
// /api/exec endpoint. fs operations are handled by remote-fs-node directly;
// this module only covers command execution.

const http = require("http");
const https = require("https");
const { execFileSync } = require("child_process");

function create(cfg) {
  const token = cfg.token;
  const tls = cfg.tls || false;
  const port = cfg.port || 8765;
  const host = cfg.host;
  const lib = tls ? https : http;
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const baseURL = (tls ? "https://" : "http://") + (host.includes(":") ? "[" + host + "]" : host) + ":" + port;

  function sftpExec(cmd) {
    const result = execFileSync("curl", [
      "-s", "-S", "--max-time", "30",
      "-H", "Authorization: Bearer " + token,
      "-H", "Content-Type: application/json",
      "-d", JSON.stringify({ cmd, shell: true }),
      baseURL + "/api/exec",
    ], { maxBuffer: 64 * 1024 * 1024 });
    const r = JSON.parse(result.toString("utf8"));
    return {
      stdout: Buffer.from(r.stdout || ""),
      stderr: Buffer.from(r.stderr || ""),
      exitCode: r.exit_code ?? 0,
    };
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
