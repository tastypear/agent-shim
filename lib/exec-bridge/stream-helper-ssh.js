"use strict";
// Subprocess helper (SSH mode): connects to the remote via ssh2, runs conn.exec(cmd),
// pipes stdout/stderr to this process's stdout/stderr (the fds qoder passed to spawn),
// and exits with the remote exit code. qoder sees a real ChildProcess — identical to
// local execution.
//
// Args: [0]=cmd [1]=jsonConfig ({host,port,user,keyPath,ssh2Path,keepaliveInterval,readyTimeout,socksProxy})
const fs = require("fs");
const cmd = process.argv[2];
const jsonConfig = process.argv[3];

if (!cmd || !jsonConfig) {
  process.stderr.write("stream-helper-ssh: missing arguments\n");
  process.exit(127);
}

let cfg;
try { cfg = JSON.parse(jsonConfig); }
catch (e) {
  process.stderr.write("stream-helper-ssh: invalid config json: " + e.message + "\n");
  process.exit(127);
}
if (!cfg.host || !cfg.user || !cfg.keyPath || !cfg.ssh2Path) {
  process.stderr.write("stream-helper-ssh: incomplete config\n");
  process.exit(127);
}

let Client;
try { Client = require(cfg.ssh2Path).Client; }
catch (e) {
  process.stderr.write("stream-helper-ssh: cannot load ssh2: " + e.message + "\n");
  process.exit(127);
}

const conn = new Client();
let exited = false;
let streamRef = null;

function finish(code) {
  if (exited) return;
  exited = true;
  try { conn.end(); } catch (_) {}
  process.exit(code || 0);
}

conn.on("ready", () => {
  const tryExec = (attempt) => {
    try {
      conn.exec(cmd, (err, stream) => {
        if (err) {
          if (err.message && err.message.includes("Channel open failure") && attempt < 3) {
            setTimeout(() => tryExec(attempt + 1), 200 * (attempt + 1));
            return;
          }
          process.stderr.write(err.message + "\n");
          finish(127);
          return;
        }
        streamRef = stream;
        process.stdin.pipe(stream);
        stream.on("data", (d) => process.stdout.write(d));
        // ssh2 puts stderr on a separate Readable (stream.stderr). MUST consume it or
        // the SSH flow-control window stalls, blocking stdout too.
        if (stream.stderr) stream.stderr.on("data", (d) => process.stderr.write(d));
        let ec = 0;
        stream.on("exit", (c) => { ec = c ?? 0; });
        stream.on("close", () => {
          try { stream.destroy(); } catch (_) {}
          finish(ec);
        });
      });
    } catch (e) {
      process.stderr.write("stream-helper-ssh: exec failed: " + e.message + "\n");
      finish(127);
    }
  };
  tryExec(0);
});

conn.on("error", (err) => {
  if (exited) return;
  process.stderr.write("stream-helper-ssh: conn error: " + (err && err.message || err) + "\n");
  finish(127);
});

// Signal forwarding: when qoder kills the subprocess, destroy the SSH stream (closes
// the channel — remote process typically gets SIGHUP) and re-raise the signal.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, function onSig() {
    if (streamRef) { try { streamRef.destroy(); } catch (_) {} }
    process.removeListener(sig, onSig);
    try { process.kill(process.pid, sig); } catch (_) { finish(130); }
  });
}

// Connect — through a SOCKS5 proxy or direct TCP. Mirrors sftp-worker.js connect().
function doDirectConnect() {
  conn.connect({
    host: cfg.host,
    port: cfg.port || 22,
    username: cfg.user,
    privateKey: fs.readFileSync(cfg.keyPath),
    keepaliveInterval: cfg.keepaliveInterval,
    keepaliveCountMax: 6,
    readyTimeout: cfg.readyTimeout,
  });
}

if (cfg.socksProxy) {
  let px = String(cfg.socksProxy).replace(/^socks5?:\/\//, "");
  const colon = px.lastIndexOf(":");
  const proxyHost = colon > 0 ? px.slice(0, colon) : "127.0.0.1";
  const proxyPort = colon > 0 ? parseInt(px.slice(colon + 1), 10) : 1080;
  let SocksClient;
  try { SocksClient = require("socks").SocksClient; }
  catch (e) {
    process.stderr.write("stream-helper-ssh: cannot load socks: " + e.message + "\n");
    process.exit(127);
  }
  SocksClient.createConnection({
    proxy: { host: proxyHost, port: proxyPort, type: 5 },
    command: "connect",
    destination: { host: cfg.host, port: cfg.port || 22 },
  }).then((info) => {
    conn.connect({
      sock: info.socket,
      username: cfg.user,
      privateKey: fs.readFileSync(cfg.keyPath),
      keepaliveInterval: cfg.keepaliveInterval,
      keepaliveCountMax: 6,
      readyTimeout: cfg.readyTimeout,
    });
  }).catch((e) => {
    process.stderr.write("stream-helper-ssh: SOCKS connect failed: " + e.message + "\n");
    process.exit(127);
  });
} else {
  doDirectConnect();
}
