// lib/sftp-client.js
// Main-thread SFTP client: owns the Worker, SharedArrayBuffers, and the synchronous
// sftpCall/sftpExec interface used by fs-bridge and exec-bridge.
//
// FAIL-CLOSED design: if the SFTP worker isn't ready or is dead, remote ops throw —
// NEVER spawn a per-op `ssh` process (that was the connection-storm root cause).

const { Worker } = require("worker_threads");
const path = require("path");
const _log = require("./logger");
const _sftpLog = _log.child("sftp");

const WORKER_PATH = path.join(__dirname, "sftp-worker.js");

// SFTP op codes (must match sftp-worker.js):
// 0=readFile 1=writeFile 2=lstat 3=readdir 4=stat(exists) 5=mkdir
// 6=unlink 7=rename 9=rmdir 10=exec
const OP = {
  readFile: 0, writeFile: 1, lstat: 2, readdir: 3, exists: 4,
  mkdir: 5, unlink: 6, rename: 7, rmdir: 9, exec: 10,
};
const _OP_NAMES = ["readFile", "writeFile", "lstat", "readdir", "exists", "mkdir", "unlink", "rename", "?", "rmdir", "exec"];

function create(cfg, onStatus) {
  const SAB_SIGNAL = new SharedArrayBuffer(16); // [0]=op-done [1]=conn-ready [2]=dead
  const SAB_DATA = new SharedArrayBuffer(16 * 1024 * 1024);
  const signal = new Int32Array(SAB_SIGNAL);
  const dataBuf = Buffer.from(SAB_DATA);

  // ===== Async exec pending map (parallel) =====
  // Each sftpExecAsync call gets a unique id; the worker posts back {type:"execResult",id,...}
  // without touching the SAB, so the main thread never blocks on Atomics.wait for exec.
  // Multiple execs run concurrently (one ssh2 channel each) over the single connection.
  let asyncId = 1;
  const asyncPending = new Map();

  let worker = null;
  try {
    worker = new Worker(WORKER_PATH, {
      workerData: {
        sabSignal: SAB_SIGNAL,
        sabData: SAB_DATA,
        ssh2Path: cfg.ssh2Path,
        keyPath: cfg.keyPath,
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        keepaliveInterval: cfg.keepaliveInterval,
        readyTimeout: cfg.readyTimeout,
        socksProxy: cfg.socksProxy || "",
      },
    });
    if (onStatus) {
      worker.on("message", (msg) => {
        if (msg.type === "ready") onStatus("ready", msg.ms);
        else if (msg.type === "dead") onStatus("dead");
        else if (msg.type === "error") onStatus("error", msg.message);
        else if (msg.type === "diag") onStatus("diag", msg.message);
        else if (msg.type === "reconnect") onStatus("reconnect", msg.attempt, msg.delay);
        // execResult is handled by the async pending map below, not onStatus.
      });
    }
    // execResult routing must be attached regardless of onStatus (the above block only
    // registers when onStatus is truthy). Attach a dedicated listener for async results.
    worker.on("message", (msg) => {
      if (msg.type !== "execResult") return;
      const pending = asyncPending.get(msg.id);
      if (!pending) return; // stale / already rejected
      asyncPending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        // stdout/stderr may be transferred Buffers (zero-copy) or fresh Buffers.
        pending.resolve({
          stdout: Buffer.isBuffer(msg.stdout) ? msg.stdout : Buffer.from(msg.stdout || ""),
          stderr: Buffer.isBuffer(msg.stderr) ? msg.stderr : Buffer.from(msg.stderr || ""),
          exitCode: msg.exitCode ?? 0,
        });
      }
    });
    worker.on("error", (e) => {
      // Reject all in-flight async execs — the worker is gone.
      for (const [, p] of asyncPending) p.reject(new Error("SFTP worker error: " + e.message));
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

  // Do NOT unref the worker — it needs to stay scheduled to load ssh2 and connect.
  process.on("exit", () => {
    if (worker) {
      try {
        worker.terminate();
      } catch (e) {}
    }
  });

  let _readyWaiting = false;
  function waitForReady() {
    if (!worker) return false;
    if (Atomics.load(signal, 2) === 1) return false; // dead
    if (Atomics.load(signal, 1) === 1) return true;
    if (_readyWaiting) {
      // Another op is already blocking on the gate; poll briefly for its result
      // rather than spawning ssh. Bounded short wait, then fail-closed.
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
      if (Atomics.load(signal, 2) === 1) break; // dead
      if (Atomics.load(signal, 1) === 1) break; // ready
      Atomics.wait(signal, 1, 0, Math.min(deadline - Date.now(), 5000));
    }
    _readyWaiting = false;
    return Atomics.load(signal, 1) === 1;
  }

  function sftpCall(op, filePath, writeData, extraPath) {
    _sftpLog.traceLazy("call", () => ({ op: _OP_NAMES[op] || ("op" + op), p: String(filePath).slice(0, 80) }));
    // FAIL-CLOSED: if SFTP isn't ready, throw. Never spawn ssh per-op (storm).
    if (!worker || Atomics.load(signal, 2) === 1) {
      const e = new Error("SFTP unavailable (worker dead) — remote op refused: " + filePath);
      e.code = "ESFTPDEAD";
      throw e;
    }
    if (Atomics.load(signal, 1) !== 1 && !waitForReady()) {
      const e = new Error("SFTP not ready (timeout) — remote op refused: " + filePath);
      e.code = "ESFTPTIMEOUT";
      throw e;
    }
    dataBuf.writeInt32LE(op, 0);
    // Byte length, NOT .length (UTF-16 code units) — Unicode paths (e.g. the /◦<host∶port>/
    // workspace prefix) encode to more utf8 bytes than code units, and the worker reads back
    // by byte length. Using .length truncates multibyte chars, corrupting the path.
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
      // COPY out of the SharedArrayBuffer — never return a view. A view would be
      // corrupted by the next sftpCall (which writes opcode+path to offset 0,
      // overwriting the response region) or by the worker's next response write.
      // This was the root cause of Edit "0 occurrences", Read returning paths/
      // stat-JSON, and copyFile remote→remote data corruption.
      const d = len > 0 ? Buffer.allocUnsafe(len) : Buffer.alloc(0);
      if (len > 0) dataBuf.copy(d, 0, 8, 8 + len);
      if (st === 1) {
        const m = d.toString("utf8");
        if (m.includes("No such") || m.includes("ENOENT")) {
          const e = new Error("ENOENT: '" + filePath + "'");
          e.code = "ENOENT";
          throw e;
        }
        throw new Error(m);
      }
      return d;
    }
    // Op timed out — fail-closed, do NOT fall back to ssh.
    const e = new Error("SFTP op timeout (30s) — refused: " + filePath);
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

  // Async exec — does NOT block the main thread. Returns a Promise that resolves
  // when the worker posts back the result over a dedicated ssh2 channel. Multiple
  // calls run concurrently. Used by makeSftpExecChild (the cp.spawn hot path) so
  // parallel Agent subagents / parallel rg invocations don't serialize on the SAB.
  // If the worker is dead or not ready within readyTimeout, fails closed (rejects)
  // rather than spawning ssh — same storm-prevention discipline as sftpCall.
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
    const e = new Error("SFTP unavailable (worker dead) — remote op refused: " + filePath);
    e.code = "ESFTPDEAD";
    return e;
  }
  function makeTimeoutError(filePath) {
    const e = new Error("SFTP not ready (timeout) — remote op refused: " + filePath);
    e.code = "ESFTPTIMEOUT";
    return e;
  }

  return { sftpCall, sftpExec, sftpExecAsync, OP, signal, worker };
}

module.exports = { create, OP };
