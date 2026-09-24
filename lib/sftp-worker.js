// lib/sftp-worker.js
// SFTP worker thread — runs in a Worker created by sftp-client.js.
//
// Receives workerData: { sabSignal, sabData, ssh2Path, keyPath, host, port, user,
//                        keepaliveInterval, readyTimeout }
//
// Communicates with the main thread via a SharedArrayBuffer:
//   signal[0] = op-done flag (1 = result ready, 0 = waiting)
//   signal[1] = connection-ready flag (1 = ready, 0 = not yet)
//   signal[2] = dead flag (1 = worker gave up reconnecting)
//   dataBuf   = request/response payload buffer (op + path + data)
//
// The main thread writes a request into dataBuf, posts {type:"request"}, then
// Atomics.wait(signal, 0, 0) blocks until this worker writes the response and
// Atomics.notify(signal, 0).

const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");

// Surface any uncaught error to the main thread instead of dying silently.
process.on("uncaughtException", (e) => {
  try { parentPort.postMessage({ type: "error", message: "uncaught: " + (e && e.stack || e) }); } catch (_) {}
});

const signal = new Int32Array(workerData.sabSignal);
const dataBuf = Buffer.from(workerData.sabData);
const _wt0 = Date.now();

let Client;
try {
  Client = require(workerData.ssh2Path).Client;
} catch (e) {
  setDead();
  throw e;
}

const MAX_RECONNECT = 5;
let reconnectCount = 0;
let sftp = null;
let conn = null;
let connecting = false;
const pendingQueue = [];

function setReady(v) {
  Atomics.store(signal, 1, v ? 1 : 0);
  if (v) Atomics.notify(signal, 1);
}

function setDead() {
  Atomics.store(signal, 2, 1);
  Atomics.notify(signal, 2);
}

function connect() {
  if (connecting) return;
  connecting = true;
  if (conn) {
    try {
      conn.end();
    } catch (e) {}
  }
  conn = null;
  sftp = null;
  setReady(false);

  conn = new Client();
  const _ct0 = Date.now();
  conn.on("ready", () => {
    parentPort.postMessage({ type: "diag", message: "ssh ready in " + (Date.now()-_ct0) + "ms" });
    conn.sftp((err, s) => {
      connecting = false;
      if (err) {
        parentPort.postMessage({ type: "error", message: "SFTP:" + err.message });
        if (reconnectCount < MAX_RECONNECT) {
          reconnectCount++;
          setTimeout(connect, Math.min(32000, 2000 * Math.pow(2, reconnectCount - 1)));
        }
        return;
      }
      sftp = s;
      reconnectCount = 0;
      setReady(true);
      parentPort.postMessage({ type: "ready", ms: Date.now() - _wt0 });
      while (pendingQueue.length > 0) pendingQueue.shift()();
      while (asyncQueue.length > 0) asyncQueue.shift()();
    });
  });
  conn.on("error", () => {
    sftp = null;
    connecting = false;
    setReady(false);
  });
  conn.on("close", () => {
    sftp = null;
    connecting = false;
    setReady(false);
    if (reconnectCount < MAX_RECONNECT) {
      reconnectCount++;
      const d = Math.min(32000, 2000 * Math.pow(2, reconnectCount - 1));
      parentPort.postMessage({ type: "reconnect", attempt: reconnectCount, delay: d });
      setTimeout(connect, d);
    } else {
      parentPort.postMessage({ type: "dead" });
      setDead();
    }
  });
  // If a SOCKS5 proxy is configured (e.g. wstunnel QUIC tunnel), connect through it
  // instead of direct TCP. socks.SocksClient.createConnection returns a raw net.Socket
  // that ssh2 accepts as its `sock` option.
  function doConnect() {
    conn.connect({
      host: workerData.host,
      port: workerData.port || 22,
      username: workerData.user,
      privateKey: fs.readFileSync(workerData.keyPath),
      keepaliveInterval: workerData.keepaliveInterval,
      keepaliveCountMax: 6,
      readyTimeout: workerData.readyTimeout,
    });
  }

  if (workerData.socksProxy) {
    // Parse "host:port" or "socks5://host:port"
    let px = String(workerData.socksProxy).replace(/^socks5?:\/\//, "");
    const colon = px.lastIndexOf(":");
    const proxyHost = colon > 0 ? px.slice(0, colon) : "127.0.0.1";
    const proxyPort = colon > 0 ? parseInt(px.slice(colon + 1), 10) : 1080;
    const { SocksClient } = require("socks");
    SocksClient.createConnection({
      proxy: { host: proxyHost, port: proxyPort, type: 5 },
      command: "connect",
      destination: { host: workerData.host, port: workerData.port || 22 },
    }).then((info) => {
      conn.connect({
        sock: info.socket,
        username: workerData.user,
        privateKey: fs.readFileSync(workerData.keyPath),
        keepaliveInterval: workerData.keepaliveInterval,
        keepaliveCountMax: 6,
        readyTimeout: workerData.readyTimeout,
      });
    }).catch((e) => {
      parentPort.postMessage({ type: "error", message: "SOCKS connect failed: " + e.message });
      connecting = false;
      setReady(false);
      if (reconnectCount < MAX_RECONNECT) {
        reconnectCount++;
        const d = Math.min(32000, 2000 * Math.pow(2, reconnectCount - 1));
        parentPort.postMessage({ type: "reconnect", attempt: reconnectCount, delay: d });
        setTimeout(connect, d);
      } else {
        parentPort.postMessage({ type: "dead" });
        setDead();
      }
    });
  } else {
    doConnect();
  }
}

connect();

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

function withSftp(fn) {
  if (sftp) {
    fn();
    return;
  }
  pendingQueue.push(fn);
}

// ===== Async exec channel (parallel) =====
// Separate from the SAB sync path. Each exec request gets a unique id; the main
// thread does NOT block on Atomics.wait for these — it awaits a postMessage reply.
// conn.exec opens a fresh channel per request, so multiple execs run concurrently
// over the single SSH connection. fs sync ops still use the SAB single-slot path.
const asyncQueue = [];
function withConnAsync(fn) {
  if (sftp || conn) {
    fn();
    return;
  }
  asyncQueue.push(fn);
}

parentPort.on("message", (msg) => {
  // Async exec — does NOT touch the SAB. Runs concurrently with other async execs
  // and with any in-flight SAB sync op (each uses its own ssh2 channel/sftp call).
  if (msg.type === "exec" && msg.id != null) {
    withConnAsync(() => {
      // Retry on "Channel open failure" (server at MaxSessions limit). Bounded backoff
      // gives a closing session time to free up — prevents transient failures from
      // surfacing as empty stdout to the caller.
      const tryExec = (attempt) => {
        try {
          conn.exec(msg.cmd, (err, stream) => {
            if (err) {
              if (
                err.message &&
                err.message.includes("Channel open failure") &&
                attempt < 3
              ) {
                setTimeout(() => tryExec(attempt + 1), 200 * (attempt + 1));
                return;
              }
              parentPort.postMessage({ type: "execResult", id: msg.id, error: err.message });
              return;
            }
            let so = Buffer.alloc(0);
            let se = Buffer.alloc(0);
            let ec = 0;
            stream.on("data", (d) => (so = Buffer.concat([so, d])));
            // ssh2 puts stderr on a separate Readable (stream.stderr), NOT as a 'stderr'
            // event on the main stream. Failing to consume it blocks the SSH flow-control
            // window, which can stall stdout too.
            if (stream.stderr) stream.stderr.on("data", (d) => (se = Buffer.concat([se, d])));
            stream.on("exit", (c) => { ec = c ?? 0; });
            stream.on("close", () => {
              try { stream.destroy(); } catch (e) {}
              parentPort.postMessage({
                type: "execResult", id: msg.id, exitCode: ec,
                stdout: so, stderr: se,
              });
            });
          });
        } catch (e) {
          parentPort.postMessage({ type: "execResult", id: msg.id, error: "w:" + e.message });
        }
      };
      tryExec(0);
    });
    return;
  }

  if (msg.type !== "request") return;
  const op = dataBuf.readInt32LE(0);
  const pl = dataBuf.readInt32LE(4);
  const fp = dataBuf.toString("utf8", 8, 8 + pl);

  withSftp(() => {
    try {
      if (op === 0) {
        // readFile
        sftp.readFile(fp, (e, b) => wr(e ? 1 : 0, e ? e.message : b || Buffer.alloc(0)));
      } else if (op === 1) {
        // writeFile
        const dl = dataBuf.readInt32LE(8 + pl);
        const c = Buffer.from(workerData.sabData, 8 + pl + 4, dl);
        sftp.writeFile(fp, c, (e) => wr(e ? 1 : 0, e ? e.message : ""));
      } else if (op === 2) {
        // lstat
        sftp.lstat(fp, (e, st) => {
          if (e) {
            wr(1, e.message);
            return;
          }
          wr(0, JSON.stringify({
            size: st.size || 0,
            mode: st.mode || 0,
            isFile: st.isFile ? st.isFile() : false,
            isDirectory: st.isDirectory ? st.isDirectory() : false,
            isSymbolicLink: st.isSymbolicLink ? st.isSymbolicLink() : false,
            mtimeMs: st.mtime instanceof Date ? st.mtime.getTime() : (st.mtime || 0),
            ctimeMs: st.ctime instanceof Date ? st.ctime.getTime() : (st.ctime || 0),
            atimeMs: st.atime instanceof Date ? st.atime.getTime() : (st.atime || 0),
            uid: st.uid || 0,
            gid: st.gid || 0,
            dev: 0, ino: 0, nlink: 1, rdev: 0, blksize: 4096, blocks: 0,
          }));
        });
      } else if (op === 3) {
        // readdir — return name + type info so fs.readdirSync can construct Dirent
        // objects when {withFileTypes: true} is requested.
        sftp.readdir(fp, (e, l) => {
          if (e) {
            wr(1, e.message);
            return;
          }
          wr(0, JSON.stringify(l.map((f) => {
            const mode = (f.attrs && f.attrs.mode) || 0;
            const t = mode & 0o170000;
            return {
              n: f.filename,
              f: t === 0o100000,
              d: t === 0o040000,
              l: t === 0o120000,
            };
          })));
        });
      } else if (op === 4) {
        // stat (exists check)
        sftp.stat(fp, (e) => wr(0, JSON.stringify({ exists: !e })));
      } else if (op === 5) {
        // mkdir
        sftp.mkdir(fp, true, (e) => wr(e ? 1 : 0, e ? e.message : ""));
      } else if (op === 6) {
        // unlink
        sftp.unlink(fp, (e) => wr(e ? 1 : 0, e ? e.message : ""));
      } else if (op === 7) {
        // rename — SFTP rename fails if the destination already exists.
        // qoder's mT() writes a .tmp file then renames over the original. We need
        // POSIX semantics (atomic overwrite), so delete the destination first.
        const nl = dataBuf.readInt32LE(8 + pl);
        const np = dataBuf.toString("utf8", 8 + pl + 4, 8 + pl + 4 + nl);
        sftp.stat(np, (se) => {
          const doRename = () => sftp.rename(fp, np, (e) => wr(e ? 1 : 0, e ? e.message : ""));
          if (se) { doRename(); return; }
          // Destination exists — delete it first, then rename.
          sftp.unlink(np, (ue) => doRename());
        });
      } else if (op === 9) {
        // rmdir
        sftp.rmdir(fp, (e) => wr(e ? 1 : 0, e ? e.message : ""));
      } else if (op === 10) {
        // exec
        conn.exec(fp, (err, stream) => {
          if (err) {
            wr(1, err.message);
            return;
          }
          let so = Buffer.alloc(0);
          let se = Buffer.alloc(0);
          let ec = 0;
          stream.on("data", (d) => (so = Buffer.concat([so, d])));
          if (stream.stderr) stream.stderr.on("data", (d) => (se = Buffer.concat([se, d])));
          stream.on("exit", (c) => {
            ec = c ?? 0;
          });
          stream.on("close", () => {
            const buf = Buffer.allocUnsafe(4 + 4 + so.length + 4 + se.length);
            buf.writeInt32LE(ec, 0);
            buf.writeInt32LE(so.length, 4);
            so.copy(buf, 8);
            buf.writeInt32LE(se.length, 8 + so.length);
            se.copy(buf, 12 + so.length);
            try { stream.destroy(); } catch (e) {}
            wr(0, buf);
          });
        });
      }
    } catch (e) {
      wr(1, "w:" + e.message);
    }
  });
});
