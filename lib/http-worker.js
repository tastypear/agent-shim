// lib/http-worker.js
// HTTP worker thread — runs in a Worker created by http-client.js.
//
// Drop-in replacement for sftp-worker.js: same SharedArrayBuffer protocol,
// same op codes, but translates SFTP ops to remote-ops-server HTTP API calls
// instead of ssh2 SFTP protocol.
//
// The main thread blocks on Atomics.wait(signal, 0) while this worker makes
// an async http.request. The worker's event loop runs independently, so the
// HTTP response callback fires, writes the result to the SharedArrayBuffer,
// and Atomics.notify wakes the main thread.

const { parentPort, workerData } = require("worker_threads");
const http = require(workerData.tls ? "https" : "http");

process.on("uncaughtException", (e) => {
  try { parentPort.postMessage({ type: "error", message: "uncaught: " + (e && e.stack || e) }); } catch (_) {}
});

const signal = new Int32Array(workerData.sabSignal);
const dataBuf = Buffer.from(workerData.sabData);

const TOKEN = workerData.token;
const BASE_HEADERS = { Authorization: "Bearer " + TOKEN };

// HTTP is stateless — no connection to establish. Signal ready immediately.
Atomics.store(signal, 1, 1);
Atomics.notify(signal, 1);
parentPort.postMessage({ type: "ready", ms: 0 });

function httpReq(method, urlPath, body, contentType, cb) {
  const headers = { ...BASE_HEADERS };
  if (contentType) headers["Content-Type"] = contentType;
  const opts = {
    hostname: workerData.host,
    port: workerData.port,
    path: urlPath,
    method,
    headers,
  };
  const req = http.request(opts, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => cb(res.statusCode, Buffer.concat(chunks)));
  });
  req.on("error", (e) => cb(0, Buffer.from(e.message)));
  if (body) req.write(body);
  req.end();
}

function wr(st, d) {
  if (Buffer.isBuffer(d)) {
    dataBuf.writeInt32LE(st, 0);
    dataBuf.writeInt32LE(d.length, 4);
    d.copy(dataBuf, 8);
  } else if (typeof d === "string") {
    dataBuf.writeInt32LE(st, 0);
    dataBuf.writeInt32LE(Buffer.byteLength(d), 4);
    dataBuf.write(d, 8, "utf8");
  } else {
    dataBuf.writeInt32LE(st, 0);
    dataBuf.writeInt32LE(0, 4);
  }
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}

function jsonBody(obj) {
  return Buffer.from(JSON.stringify(obj));
}

parentPort.on("message", (msg) => {
  // Async exec — does NOT touch the SAB.
  if (msg.type === "exec" && msg.id != null) {
    httpReq("POST", "/api/exec", jsonBody({ cmd: msg.cmd, shell: true }), "application/json", (code, buf) => {
      if (code !== 200) {
        parentPort.postMessage({ type: "execResult", id: msg.id, error: buf.toString("utf8") });
        return;
      }
      try {
        const r = JSON.parse(buf.toString("utf8"));
        parentPort.postMessage({
          type: "execResult", id: msg.id,
          exitCode: r.exit_code ?? 0,
          stdout: Buffer.from(r.stdout || ""),
          stderr: Buffer.from(r.stderr || ""),
        });
      } catch (e) {
        parentPort.postMessage({ type: "execResult", id: msg.id, error: e.message });
      }
    });
    return;
  }

  if (msg.type !== "request") return;
  const op = dataBuf.readInt32LE(0);
  const pl = dataBuf.readInt32LE(4);
  const fp = dataBuf.toString("utf8", 8, 8 + pl);
  const qp = encodeURIComponent(fp);

  try {
    if (op === 0) {
      // readFile — response body is raw file content
      httpReq("GET", "/api/fs/read?path=" + qp, null, null, (code, buf) => {
        if (code !== 200) wr(1, buf.toString("utf8"));
        else wr(0, buf);
      });
    } else if (op === 1) {
      // writeFile — request body is raw file content
      const dl = dataBuf.readInt32LE(8 + pl);
      const content = Buffer.from(workerData.sabData, 8 + pl + 4, dl);
      httpReq("PUT", "/api/fs/write?path=" + qp, content, "application/octet-stream", (code, buf) => {
        wr(code === 200 ? 0 : 1, code === 200 ? "" : buf.toString("utf8"));
      });
    } else if (op === 2) {
      // lstat — convert server stat to sftp-worker format
      httpReq("GET", "/api/fs/stat?path=" + qp, null, null, (code, buf) => {
        if (code !== 200) { wr(1, buf.toString("utf8") || "ENOENT"); return; }
        try {
          const s = JSON.parse(buf.toString("utf8"));
          wr(0, JSON.stringify({
            size: s.size || 0,
            mode: s.fullMode || 0,
            isFile: s.type === "file",
            isDirectory: s.type === "dir",
            isSymbolicLink: s.type === "link",
            mtimeMs: s.mtime || 0,
            ctimeMs: s.ctime || 0,
            atimeMs: s.atime || 0,
            uid: s.uid || 0, gid: s.gid || 0,
            dev: s.dev || 0, ino: s.ino || 0,
            nlink: s.nlink || 1, rdev: s.rdev || 0,
            blksize: s.blksize || 4096, blocks: s.blocks || 0,
          }));
        } catch (e) { wr(1, e.message); }
      });
    } else if (op === 3) {
      // readdir — convert server list to sftp-worker format
      httpReq("GET", "/api/fs/list?path=" + qp, null, null, (code, buf) => {
        if (code !== 200) { wr(1, buf.toString("utf8")); return; }
        try {
          const entries = JSON.parse(buf.toString("utf8"));
          wr(0, JSON.stringify(entries.map((e) => ({
            n: e.name,
            f: e.type === "file",
            d: e.type === "dir",
            l: e.type === "link",
          }))));
        } catch (e) { wr(1, e.message); }
      });
    } else if (op === 4) {
      // exists — 200 = exists, 404 = not
      httpReq("GET", "/api/fs/stat?path=" + qp, null, null, (code) => {
        wr(0, JSON.stringify({ exists: code === 200 }));
      });
    } else if (op === 5) {
      // mkdir
      httpReq("POST", "/api/fs/mkdir", jsonBody({ path: fp, recursive: true }), "application/json", (code, buf) => {
        wr(code === 200 ? 0 : 1, code === 200 ? "" : buf.toString("utf8"));
      });
    } else if (op === 6) {
      // unlink
      httpReq("POST", "/api/fs/delete", jsonBody({ path: fp }), "application/json", (code, buf) => {
        wr(code === 200 ? 0 : 1, code === 200 ? "" : buf.toString("utf8"));
      });
    } else if (op === 7) {
      // rename — os.Rename on the server is atomic with overwrite, no need for stat+unlink
      const nl = dataBuf.readInt32LE(8 + pl);
      const np = dataBuf.toString("utf8", 8 + pl + 4, 8 + pl + 4 + nl);
      httpReq("POST", "/api/fs/move", jsonBody({ src: fp, dst: np }), "application/json", (code, buf) => {
        wr(code === 200 ? 0 : 1, code === 200 ? "" : buf.toString("utf8"));
      });
    } else if (op === 9) {
      // rmdir — same as unlink (server uses os.RemoveAll)
      httpReq("POST", "/api/fs/delete", jsonBody({ path: fp }), "application/json", (code, buf) => {
        wr(code === 200 ? 0 : 1, code === 200 ? "" : buf.toString("utf8"));
      });
    } else if (op === 10) {
      // exec (sync) — pack as binary: [exitCode(int32), stdoutLen(int32), stdout, stderrLen(int32), stderr]
      httpReq("POST", "/api/exec", jsonBody({ cmd: fp, shell: true }), "application/json", (code, buf) => {
        if (code !== 200) { wr(1, buf.toString("utf8")); return; }
        try {
          const r = JSON.parse(buf.toString("utf8"));
          const so = Buffer.from(r.stdout || "");
          const se = Buffer.from(r.stderr || "");
          const out = Buffer.allocUnsafe(4 + 4 + so.length + 4 + se.length);
          out.writeInt32LE(r.exit_code ?? 0, 0);
          out.writeInt32LE(so.length, 4);
          so.copy(out, 8);
          out.writeInt32LE(se.length, 8 + so.length);
          se.copy(out, 12 + so.length);
          wr(0, out);
        } catch (e) { wr(1, e.message); }
      });
    }
  } catch (e) {
    wr(1, "w:" + e.message);
  }
});
