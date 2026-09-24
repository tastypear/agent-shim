// lib/debug-hooks.js
// Optional instrumentation layer, activated by QODER_REMOTE_DEBUG=1 and/or QODER_SFTP_TRACE=1.
// Mounted AFTER core modules are patched, so it wraps the already-patched functions — core
// stays clean of any debug logic.
//
// Hooks:
//   - isRemote trace: logs every classification decision to stderr
//   - fs call trace: logs every patched fs sync call (path + remote verdict)
//   - SFTP op trace: logs every sftpCall/sftpExec to a trace file
//   - spawn/exec trace: logs every intercepted spawn/exec
//   - fs.promises trace: logs every P.* call
//   - EXIT-CHECK: at process exit, verifies patches survived + writes a test file

const fs = require("fs");
const os = require("os");
const path = require("path");

function isActive() {
  return process.env.QODER_REMOTE_DEBUG === "1";
}

function traceActive() {
  return process.env.QODER_SFTP_TRACE === "1";
}

// Open a trace log file for SFTP op tracing.
let _tfd = -1;
function getTraceFd() {
  if (_tfd >= 0) return _tfd;
  if (!traceActive()) return -1;
  const dir = process.env.REMOTE_BRIDGE_TRACE_DIR || os.tmpdir();
  const p = path.join(dir, "sftp_trace.log");
  try {
    _tfd = fs.openSync(p, "a");
  } catch (e) {
    _tfd = -1;
  }
  return _tfd;
}

function tw(s) {
  const fd = getTraceFd();
  if (fd >= 0) {
    try {
      fs.writeSync(fd, s + "\n");
    } catch (e) {}
  }
}

const _OP_NAMES = ["readFile", "writeFile", "lstat", "readdir", "exists", "mkdir", "unlink", "rename", "?", "rmdir", "exec"];
function opName(op) {
  return _OP_NAMES[op] || "op" + op;
}

// Wrap sftpCall/sftpExec to trace each op.
function wrapSftp(sftp) {
  if (!traceActive()) return;
  const origCall = sftp.sftpCall;
  sftp.sftpCall = function (op, filePath, writeData, extraPath) {
    const t0 = Date.now();
    tw("[SFTP] > " + opName(op) + " " + String(filePath).slice(0, 80));
    const r = origCall.call(this, op, filePath, writeData, extraPath);
    tw("[SFTP] < " + opName(op) + " " + String(filePath).slice(0, 80) + " " + (Date.now() - t0) + "ms");
    return r;
  };
}

// Wrap fs patched functions to trace calls (debug mode).
function wrapFs() {
  if (!isActive()) return;
  const names = ["existsSync", "statSync", "lstatSync", "readFileSync", "writeFileSync", "readdirSync", "mkdirSync", "accessSync", "openSync"];
  for (const name of names) {
    const orig = fs[name];
    if (typeof orig !== "function") continue;
    fs[name] = function (...args) {
      try {
        process.stderr.write("[FS " + name + "] " + JSON.stringify(String(args[0])).slice(0, 80) + " remote=" + (require("./classifier").isRemote(args[0])) + "\n");
      } catch (e) {}
      return orig.apply(this, args);
    };
  }
}

// Wrap cp.spawn/exec to trace routing decisions.
function wrapCp() {
  if (!isActive() && !traceActive()) return;
  const cp = require("child_process");
  const _spawn = cp.spawn;
  const _spawnSync = cp.spawnSync;
  const _stw = (s) => { if (traceActive()) tw(s); if (isActive()) process.stderr.write(s + "\n"); };
  cp.spawn = function (exe, args, opts) {
    const exeStr = String(exe || "");
    const a0 = String((args && args[0]) || "");
    const a1 = String((args && args[1]) || "");
    _stw("[spawn] exe=" + JSON.stringify(exeStr).slice(0, 50) + " a0=" + JSON.stringify(a0).slice(0, 40) + " a1=" + JSON.stringify(a1).slice(0, 60));
    return _spawn.call(cp, exe, args, opts);
  };
  cp.spawnSync = function (exe, args, opts) {
    const exeStr = String(exe || "");
    const a0 = String((args && args[0]) || "");
    _stw("[spawnSync] exe=" + JSON.stringify(exeStr).slice(0, 50) + " a0=" + JSON.stringify(a0).slice(0, 40));
    return _spawnSync.call(cp, exe, args, opts);
  };
}

// EXIT-CHECK: at process exit, verify patches survived (sync, uses fd 2 directly).
function installExitCheck(getVcwd) {
  if (!isActive()) return;
  process.on("exit", () => {
    try {
      const Pf = global.__REMOTE_PROMISES__;
      const promOk = Pf && fs.promises && fs.promises.writeFile === Pf.writeFile;
      require("fs").writeSync(2, "[EXIT-CHECK] P=" + !!Pf + " promOk=" + promOk + "\n");
      require("fs").writeSync(2, "[EXIT-CHECK] process.cwd()=" + process.cwd() + " vCwd=" + (getVcwd ? getVcwd() : "?") + "\n");
      const cc = global.__pCallCounts || {};
      require("fs").writeSync(2, "[EXIT-CHECK] P-callCounts: writeFile=" + (cc.writeFile || 0) + " stat=" + (cc.stat || 0) + " readFile=" + (cc.readFile || 0) + "\n");
      try {
        fs.writeFileSync("/root/__exit_check.txt", "EXIT_OK\n");
        require("fs").writeSync(2, "[EXIT-CHECK] writeFileSync /root OK\n");
      } catch (e) {
        require("fs").writeSync(2, "[EXIT-CHECK] writeFileSync /root threw: " + e.code + "\n");
      }
    } catch (e) {}
  });
}

// Install all debug hooks after core modules are patched.
function install(sftp, getVcwd) {
  wrapSftp(sftp);
  wrapFs();
  wrapCp();
  installExitCheck(getVcwd);
}

module.exports = { install, isActive, traceActive, tw, opName };
