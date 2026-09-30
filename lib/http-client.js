// lib/http-client.js
// Main-thread HTTP client: owns the Worker, SharedArrayBuffers, and the
// synchronous sftpCall/sftpExec interface used by fs-bridge and exec-bridge.
//
// Drop-in replacement for sftp-client.js — same interface, same op codes,
// same SharedArrayBuffer protocol. The only difference is the worker
// (http-worker.js) makes HTTP calls to remote-ops-server instead of SFTP.

const { Worker } = require("worker_threads");
const path = require("path");
const _log = require("./logger");
const _httpLog = _log.child("http");

const WORKER_PATH = path.join(__dirname, "http-worker.js");

const OP = {
  readFile: 0, writeFile: 1, lstat: 2, readdir: 3, exists: 4,
  mkdir: 5, unlink: 6, rename: 7, rmdir: 9, exec: 10,
};
const _OP_NAMES = ["readFile", "writeFile", "lstat", "readdir", "exists", "mkdir", "unlink", "rename", "?", "rmdir", "exec"];

function create(cfg, onStatus) {
  const SAB_SIGNAL = new SharedArrayBuffer(16);
  const SAB_DATA = new SharedArrayBuffer(16 * 1024 * 1024);
  const signal = new Int32Array(SAB_SIGNAL);
  const dataBuf = Buffer.from(SAB_DATA);

  let asyncId = 1;
  const asyncPending = new Map();

  let worker = null;
  try {
    worker = new Worker(WORKER_PATH, {
      workerData: {
        sabSignal: SAB_SIGNAL,
        sabData: SAB_DATA,
        host: cfg.host,
        port: cfg.port || 8765,
        token: cfg.token,
        tls: cfg.tls || false,
      },
    });
    if (onStatus) {
      worker.on("message", (msg) => {
        if (msg.type === "ready") onStatus("ready", msg.ms);
        else if (msg.type === "dead") onStatus("dead");
        else if (msg.type === "error") onStatus("error", msg.message);
        else if (msg.type === "diag") onStatus("diag", msg.message);
      });
    }
    worker.on("message", (msg) => {
      if (msg.type !== "execResult") return;
      const pending = asyncPending.get(msg.id);
      if (!pending) return;
      asyncPending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve({
          stdout: Buffer.isBuffer(msg.stdout) ? msg.stdout : Buffer.from(msg.stdout || ""),
          stderr: Buffer.isBuffer(msg.stderr) ? msg.stderr : Buffer.from(msg.stderr || ""),
          exitCode: msg.exitCode ?? 0,
        });
      }
    });
    worker.on("error", (e) => {
      for (const [, p] of asyncPending) p.reject(new Error("HTTP worker error: " + e.message));
      asyncPending.clear();
      if (onStatus) onStatus("workerError", e.message);
    });
    worker.on("exit", () => {
      for (const [, p] of asyncPending) p.reject(makeDeadError("worker exited"));
      asyncPending.clear();
    });
  } catch (e) {
    if (onStatus) onStatus("workerError", e.message);
  }

  process.on("exit", () => {
    if (worker) { try { worker.terminate(); } catch (e) {} }
  });

  let _readyWaiting = false;
  function waitForReady() {
    if (!worker) return false;
    if (Atomics.load(signal, 2) === 1) return false;
    if (Atomics.load(signal, 1) === 1) return true;
    if (_readyWaiting) {
      const dl = Date.now() + 3000;
      while (Date.now() < dl) {
        if (Atomics.load(signal, 1) === 1) return true;
        if (Atomics.load(signal, 2) === 1) return false;
        Atomics.wait(signal, 1, 0, 500);
      }
      return Atomics.load(signal, 1) === 1;
    }
    _readyWaiting = true;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (Atomics.load(signal, 2) === 1) break;
      if (Atomics.load(signal, 1) === 1) break;
      Atomics.wait(signal, 1, 0, Math.min(deadline - Date.now(), 5000));
    }
    _readyWaiting = false;
    return Atomics.load(signal, 1) === 1;
  }

  function sftpCall(op, filePath, writeData, extraPath) {
    _httpLog.traceLazy("call", () => ({ op: _OP_NAMES[op] || ("op" + op), p: String(filePath).slice(0, 120) }));
    if (!worker || Atomics.load(signal, 2) === 1) {
      const e = new Error("HTTP unavailable (worker dead) — remote op refused: " + filePath);
      e.code = "ESFTPDEAD";
      throw e;
    }
    if (Atomics.load(signal, 1) !== 1 && !waitForReady()) {
      const e = new Error("HTTP not ready (timeout) — remote op refused: " + filePath);
      e.code = "ESFTPTIMEOUT";
      throw e;
    }
    dataBuf.writeInt32LE(op, 0);
    const fpLen = Buffer.byteLength(filePath, "utf8");
    dataBuf.writeInt32LE(fpLen, 4);
    dataBuf.write(filePath, 8, "utf8");
    let off = 8 + fpLen;
    if (op === OP.writeFile && writeData) {
      dataBuf.writeInt32LE(writeData.length, off);
      writeData.copy(dataBuf, off + 4);
      off += 4 + writeData.length;
    }
    if (op === OP.rename && extraPath) {
      const epLen = Buffer.byteLength(extraPath, "utf8");
      dataBuf.writeInt32LE(epLen, off);
      dataBuf.write(extraPath, off + 4, "utf8");
    }
    Atomics.store(signal, 0, 0);
    worker.postMessage({ type: "request" });
    const r = Atomics.wait(signal, 0, 0, 30000);
    if (r === "ok" && Atomics.load(signal, 0) === 1) {
      const st = dataBuf.readInt32LE(0);
      const len = dataBuf.readInt32LE(4);
      const d = len > 0 ? Buffer.allocUnsafe(len) : Buffer.alloc(0);
      if (len > 0) dataBuf.copy(d, 0, 8, 8 + len);
      if (st === 2) {
        const e = new Error("ENOENT: '" + filePath + "'");
        e.code = "ENOENT";
        throw e;
      }
      if (st === 1) {
        throw new Error(d.toString("utf8"));
      }
      return d;
    }
    const e = new Error("HTTP op timeout (30s) — refused: " + filePath);
    e.code = "ESFTPOPTIMEOUT";
    throw e;
  }

  function sftpExec(command) {
    const d = sftpCall(OP.exec, command);
    const exitCode = d.readInt32LE(0);
    const stdoutLen = d.readInt32LE(4);
    const stdout = d.subarray(8, 8 + stdoutLen);
    const stderrLen = d.readInt32LE(8 + stdoutLen);
    const stderr = d.subarray(12 + stdoutLen, 12 + stdoutLen + stderrLen);
    return { stdout, stderr, exitCode };
  }

  function sftpExecAsync(command) {
    if (!worker || Atomics.load(signal, 2) === 1) {
      return Promise.reject(makeDeadError(command));
    }
    if (Atomics.load(signal, 1) !== 1 && !waitForReady()) {
      return Promise.reject(makeTimeoutError(command));
    }
    const id = asyncId++;
    return new Promise((resolve, reject) => {
      asyncPending.set(id, { resolve, reject });
      worker.postMessage({ type: "exec", id, cmd: command });
    });
  }

  function makeDeadError(filePath) {
    const e = new Error("HTTP unavailable (worker dead) — remote op refused: " + filePath);
    e.code = "ESFTPDEAD";
    return e;
  }
  function makeTimeoutError(filePath) {
    const e = new Error("HTTP not ready (timeout) — remote op refused: " + filePath);
    e.code = "ESFTPTIMEOUT";
    return e;
  }

  return { sftpCall, sftpExec, sftpExecAsync, OP, signal, worker };
}

module.exports = { create, OP };
