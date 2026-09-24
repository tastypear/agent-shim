// lib/exec-bridge.js
// Patches child_process (spawn, spawnSync, exec, execSync, execFile, execFileSync) so that:
//   - bash -c commands run on the remote via SFTP exec
//   - host-internal helper commands (adapter.isHostInternalCmd) run locally
//   - non-bash binaries with remote-path args route to the remote
//   - agent-specific runtime binaries (e.g. runtime-info-linux ELF) are intercepted
//
// The synthetic child returned for remote exec writes stdout/stderr to the caller's stdio
// targets SYNCHRONOUSLY before returning — qoder's Bash tool closes stdio fds in a `finally`
// right after spawn returns, so a deferred (nextTick) write would hit a closed fd.

const cp = require("child_process");
const { Readable, Writable } = require("stream");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");

const { isRemote, toRemote } = require("./classifier");

// ===== Spawn trace =====
// Logs every spawn/spawnSync/exec/execFile call with stdio config, routing decision,
// and result (stdout length, exit code). Written to a file to avoid interfering with
// qoder's TUI. Always on — the user said to keep trace logs for debugging.
const _tracePath = path.join(__dirname, "..", "spawn-trace.log");
let _tfd = -1;
try { _tfd = fs.openSync(_tracePath, "a"); } catch (e) {}
function _trace(s) {
  if (_tfd < 0) return;
  try { fs.writeSync(_tfd, Date.now() + " " + s + "\n"); } catch (e) {}
}
function _stdioDesc(opts) {
  if (!opts) return "none";
  const s = opts.stdio;
  if (!s) return "undefined";
  if (typeof s === "string") return JSON.stringify(s);
  if (Array.isArray(s)) return "[" + s.map(x => {
    if (typeof x === "number") return "fd" + x;
    if (typeof x === "string") return JSON.stringify(x);
    if (x && typeof x === "object") return x.constructor && x.constructor.name || "obj";
    return String(x);
  }).join(",") + "]";
  return String(s);
}

function extractEval(cmd) {
  const m = cmd.match(/eval\s+'([\s\S]+?)'/);
  return m ? m[1] : null;
}

function isBash(exeStr) {
  const norm = String(exeStr).replace(/\\/g, "/");
  if (norm === "bash" || norm === "sh" || norm === "bash.exe" || norm === "sh.exe") return true;
  return (
    norm.endsWith("/bash") ||
    norm.endsWith("/bash.exe") ||
    norm.endsWith("/sh") ||
    norm.endsWith("/sh.exe")
  );
}

function shellQuote(s) {
  if (s === "") return "''";
  if (/[\s'"$`\\<>|&;(){}[\]*?#~]/.test(s)) return "'" + s.replace(/'/g, "'\\''") + "'";
  return s;
}

// Capture original fs.existsSync before fs-bridge patches it at runtime.
const _existsSync = require("fs").existsSync;

// Cache local-exe lookups so each bare name is resolved at most once.
const _exeCache = new Map();
function findLocalExe(name) {
  if (_exeCache.has(name)) return _exeCache.get(name);
  let found = null;
  try {
    const PATH = process.env.PATH || "";
    const PATHEXT = (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";");
    for (const dir of PATH.split(";")) {
      if (!dir) continue;
      for (const ext of PATHEXT) {
        if (_existsSync(dir + "\\" + name + ext)) { found = dir + "\\" + name + ext; break; }
      }
      if (found) break;
    }
  } catch (e) {}
  _exeCache.set(name, found);
  return found;
}

function isBareName(fileStr) {
  const norm = String(fileStr).replace(/\\/g, "/");
  return !norm.includes("/") && !/^[a-zA-Z]:/.test(norm);
}

function isWindowsExeName(fileStr) {
  return /\.(exe|cmd|bat|ps1|com)$/i.test(String(fileStr));
}

// ripgrep detection: matches "rg", "rg.exe", or any path ending in /rg or /rg.exe.
// qoder's egn() resolves rg to a bare "rg" (system mode) or a full path (builtin mode);
// both forms reach wrapSpawn as the exe argument.
function isRg(exeStr) {
  const norm = String(exeStr).replace(/\\/g, "/");
  return norm === "rg" || norm === "rg.exe" || norm.endsWith("/rg") || norm.endsWith("/rg.exe");
}

// Build a remote shell command for ripgrep. The arg list is rg's argv as qoder constructed
// it (flags + trailing positional search path like "." or a basename). We quote each arg
// and prefix `cd <cwd> &&` so rg runs in the target directory. Remote-path args (e.g. a
// file path passed to Grep) are passed through toRemote to normalize slashes.
function buildRgRemoteCmd(argList, remoteCwd) {
  const quoted = argList.map((a) => {
    const s = String(a);
    return shellQuote(isRemote(s) ? toRemote(s) : s);
  });
  return "cd " + shellQuote(remoteCwd) + " && rg " + quoted.join(" ");
}

// Decide whether a non-bash executable should be routed to remote instead of native.
// Covers three cases: (1) exe itself is a remote posix-absolute path (/usr/sbin/lsof),
// (2) any arg is a remote path, (3) bare-name Linux binary not found locally (getconf, ps).
// Windows-native executables (.exe/.cmd/.bat) are always kept local — their flags
// (e.g. cmd /c, reg /v) can look like posix-absolute paths and trigger false positives.
function shouldRouteNonBash(fileStr, argList) {
  if (isWindowsExeName(fileStr)) return false;
  if (isRemote(fileStr)) return true;
  if (argList.some((a) => isRemote(String(a)))) return true;
  if (isBareName(fileStr) && !findLocalExe(fileStr)) return true;
  return false;
}

function buildRemoteCmd(fileStr, argList) {
  return [
    shellQuote(isRemote(fileStr) ? toRemote(fileStr) : fileStr),
    ...argList.map((a) => {
      const s = String(a);
      return shellQuote(isRemote(s) ? toRemote(s) : s);
    }),
  ].join(" ");
}

// Options for localBash spawns: kill detached (creates a Windows console popup)
// and force windowsHide. platform=linux makes qoder set detached=true on every
// hook/snapshot spawn — that was the popup source.
// Also restore HOME: platform.js sets HOME=/root for the agent process, but that
// leaks into hook child processes (qodersec-launch.sh reads $HOME to find
// ~/.qodersec/bin/qodersec). With HOME=/root the script looks in the remote
// filesystem and fails. Let Git bash use its own default (Windows USERPROFILE).
//
// CRITICAL: qoder passes a custom opts.env for hook spawns that has NO PATH (or a
// Windows-style PATH). Git bash inherits that env verbatim — with an empty/missing
// PATH it can't find its own `sh`, so hook commands like `sh 'C:\...\.sh'` fail with
// "sh: command not found". We must prepend git bash's own bin dirs (/usr/bin, /bin,
// /mingw64/bin — MSYS-internal paths the bash binary always understands) so `sh`,
// `cat`, `sed` etc. are resolvable regardless of what qoder puts in env.
function cleanLocalBashOpts(opts, localBash) {
  const cleaned = Object.assign({}, opts, {
    cwd: undefined,
    detached: false,
    windowsHide: true,
  });
  if (!cleaned.env) cleaned.env = Object.assign({}, process.env);
  else cleaned.env = Object.assign({}, cleaned.env);
  // Remove our fake HOME so Git bash resolves ~/.qodersec to the real Windows home.
  delete cleaned.env.HOME;
  ensureBashPath(cleaned.env, localBash);
  return cleaned;
}

// Same env-fixing for the exec family (cp.exec/execSync/execFile/execFileSync),
// which uses {shell: localBash} instead of spawn(exe, args).
function localBashExecOpts(opts, localBash) {
  const o = Object.assign({}, opts, { shell: localBash, windowsHide: true });
  if (!o.env) o.env = Object.assign({}, process.env);
  else o.env = Object.assign({}, o.env);
  delete o.env.HOME;
  ensureBashPath(o.env, localBash);
  return o;
}

// Prepend git bash's MSYS-internal bin dirs to env.PATH so the bash process can
// always resolve sh/cat/sed/nohup even when the caller passed an empty or Windows-
// style PATH. These are posix paths the MSYS runtime understands natively.
function ensureBashPath(env, localBash) {
  const MSYS_BINS = "/usr/bin:/bin:/mingw64/bin";
  const cur = env.PATH;
  if (!cur) {
    env.PATH = MSYS_BINS;
  } else if (!String(cur).includes("/usr/bin")) {
    env.PATH = MSYS_BINS + ":" + cur;
  }
}

function writeToStdio(target, buf, streamFallback) {
  if (typeof target === "number") {
    try {
      require("fs").writeSync(target, buf);
    } catch (e) {}
  } else if (target && typeof target === "object" && typeof target.write === "function") {
    try {
      target.write(buf);
    } catch (e) {}
  } else {
    try {
      streamFallback.push(buf);
    } catch (e) {}
  }
}

function makeSftpExecChild(cmd, opts) {
  const _stdio = (opts && opts.stdio) || "pipe";
  const _outTarget = Array.isArray(_stdio) ? _stdio[1] : _stdio;
  const _errTarget = Array.isArray(_stdio) ? _stdio[2] : _stdio;
  const _hasFdOut =
    typeof _outTarget === "number" ||
    (typeof _outTarget === "object" && _outTarget && typeof _outTarget.write === "function");

  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({ write(c, e, d) { d(); } });
  child.pid = -1;
  child.unref = () => child;
  child.ref = () => child;
  child.kill = () => true;

  // ===== Routing: sync vs async =====
  // qoder's Bash tool passes fd-based stdio (e.g. ["pipe",fd6,fd6]) and closes those fds
  // in a `finally` right after spawn returns. If the exec result arrives asynchronously
  // (via __sftpExecAsync), the fd is already closed by the time we try to write to it —
  // writeToStdio fails silently and qoder sees empty stdout. This only manifests on
  // high-RTT remotes (QUIC ~300ms) where the async delay exceeds qoder's fd lifetime;
  // on low-RTT WSL (~50ms) the result arrives fast enough to slip in before the fd close.
  //
  // Fix: when _hasFdOut is true (fd/object stdio — qoder's Bash pattern), use SYNC exec
  // so the result is available and written to the fd BEFORE spawn returns. When
  // _hasFdOut is false (pipe stdio — rg/Grep pattern), use ASYNC so parallel invocations
  // don't serialize on the SAB's Atomics.wait.
  const _useSync = _hasFdOut || !global.__sftpExecAsync;

  if (!_useSync && global.__sftpExecAsync) {
    let settled = false;
    const finish = (err, r) => {
      if (settled) return;
      settled = true;
      if (err || !r) {
        const em = err ? err.message : "SFTP exec failed";
        const errBuf = Buffer.from(em + "\n");
        try { child.stderr.push(errBuf); } catch (e) {}
        try { child.stdout.push(null); } catch (e) {}
        try { child.stderr.push(null); } catch (e) {}
        child.emit("exit", 127, null);
        child.emit("close", 127, null);
        return;
      }
      if (r.stdout && r.stdout.length) { try { child.stdout.push(r.stdout); } catch (e) {} }
      if (r.stderr && r.stderr.length) { try { child.stderr.push(r.stderr); } catch (e) {} }
      try { child.stdout.push(null); } catch (e) {}
      try { child.stderr.push(null); } catch (e) {}
      const ec = r.exitCode || 0;
      child.emit("exit", ec, null);
      child.emit("close", ec, null);
    };
    global.__sftpExecAsync(cmd).then((r) => {
      _trace("spawn ASYNC(pipe) result: cmd="+JSON.stringify(String(cmd).slice(0,80))+" stdio="+_stdioDesc(opts)+" stdoutLen="+(r&&r.stdout?r.stdout.length:0)+" exit="+(r?r.exitCode:"?"));
      finish(null, r);
    }, (e) => {
      _trace("spawn ASYNC(pipe) error: "+e.message);
      finish(e, null);
    });
    return child;
  }

  // SYNC PATH: blocks via Atomics.wait until the worker returns the result. Data is
  // written to fd/child.stdout BEFORE spawn returns — qoder's fd-close-in-finally is
  // safe because the data is already in the pipe buffer. Used for all fd/object stdio
  // (qoder's Bash tool) and as fallback when __sftpExecAsync is unavailable.
  if (global.__sftpExec) {
    let r;
    try {
      r = global.__sftpExec(cmd);
      _trace("spawn SYNC result: cmd="+JSON.stringify(String(cmd).slice(0,80))+" stdio="+_stdioDesc(opts)+" hasFdOut="+_hasFdOut+" stdoutLen="+(r.stdout?r.stdout.length:0)+" exit="+(r.exitCode||0));
      if (r.stdout && r.stdout.length) { try { child.stdout.push(r.stdout); } catch (e) {} }
      if (r.stderr && r.stderr.length) { try { child.stderr.push(r.stderr); } catch (e) {} }
      if (_hasFdOut) {
        if (r.stdout && r.stdout.length) writeToStdio(_outTarget, r.stdout, child.stdout);
        if (r.stderr && r.stderr.length) writeToStdio(_errTarget, r.stderr, child.stderr);
      }
      try { child.stdout.push(null); } catch (e) {}
      try { child.stderr.push(null); } catch (e) {}
      process.nextTick(() => {
        child.emit("exit", r.exitCode || 0, null);
        child.emit("close", r.exitCode || 0, null);
      });
    } catch (err) {
      _trace("spawn SYNC error: "+err.message);
      const errBuf = Buffer.from(err.message + "\n");
      try { child.stderr.push(errBuf); } catch (e) {}
      if (_hasFdOut) writeToStdio(_errTarget, errBuf, child.stderr);
      try { child.stdout.push(null); } catch (e) {}
      try { child.stderr.push(null); } catch (e) {}
      process.nextTick(() => {
        child.emit("exit", 127, null);
        child.emit("close", 127, null);
      });
    }
    return child;
  }

  // FAIL-CLOSED: __sftpExec not ready (worker not up). Do NOT spawn ssh — that was
  // the storm vector. Return a synthetic child that exits 127 with a clear error.
  process.nextTick(() => {
    const errBuf = Buffer.from("SFTP exec unavailable (worker not ready) — refused: " + cmd + "\n");
    try { child.stderr.push(errBuf); } catch (e) {}
    if (_hasFdOut) writeToStdio(_errTarget, errBuf, child.stderr);
    try { child.stderr.push(null); } catch (e) {}
    try { child.stdout.push(null); } catch (e) {}
    child.emit("exit", 127, null);
    child.emit("close", 127, null);
  });
  return child;
}

// Intercept runtime-info-linux-x64 (ELF binary that Windows can't execute).
// umid's result promise awaits stdout data and never settles → event loop freezes.
// Return a synthetic child whose stdout pushes invalid JSON → umid's JSON.parse throws →
// it takes the reject path → result settles → no hang.
function makeRuntimeInfoChild() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({ write(c, e, d) { d(); } });
  child.pid = undefined;
  child.exitCode = 1;
  child.signalCode = null;
  child.unref = () => child;
  child.ref = () => child;
  child.kill = () => true;
  setTimeout(() => {
    child.stdout.push(Buffer.from("{\n"));
    child.stdout.push(null);
    child.stderr.push(Buffer.from("intercepted Linux ELF on Windows\n"));
    child.stderr.push(null);
    child.emit("close", 1, null);
  }, 50);
  return child;
}

function wrapSpawn(exe, args, opts, adapter, getRemoteCwd) {
  if (!exe || !args) return null;
  const exeStr = String(exe);
  const localBash = adapter.getLocalBash();

  if (!isBash(exeStr)) {
    const argList = Array.isArray(args) ? args : [];

    // ripgrep (Grep/Glob tools): route to remote when cwd or any arg is a remote path.
    // qoder spawns rg as a native child process that reads the real filesystem via Win32
    // APIs, completely bypassing fs-bridge's SFTP patches — so it can't see /root or any
    // remote path. Additionally, platform=linux makes qoder resolve rg via `which rg`
    // (returns MSYS path like /c/Users/...) which Node spawn can't execute → ENOENT.
    // Routing the whole rg invocation to sftpExec fixes both: it runs the remote rg
    // against the real remote filesystem. rgPath/args are reconstructed as a remote shell
    // command `cd <cwd> && rg <args>`; the trailing positional search path (".", basename)
    // is left intact since it's relative to cwd.
    if (isRg(exeStr)) {
      const cwd = opts && opts.cwd;
      const cwdRemote = cwd && isRemote(String(cwd));
      const argsRemote = argList.some((a) => isRemote(String(a)));
      if (cwdRemote || argsRemote) {
        const rc = cwdRemote ? toRemote(String(cwd)) : getRemoteCwd();
        const rgCmd = buildRgRemoteCmd(argList, rc);
        return {
          exe: "__sftp_exec__",
          args: [rgCmd],
          opts: Object.assign({}, opts, { cwd: undefined }),
        };
      }
    }

    if (shouldRouteNonBash(exeStr, argList)) {
      return {
        exe: "__sftp_exec__",
        args: [buildRemoteCmd(exeStr, argList)],
        opts: Object.assign({}, opts, { cwd: undefined }),
      };
    }
    if (opts && opts.cwd && isRemote(String(opts.cwd))) {
      return { exe, args, opts: Object.assign({}, opts, { cwd: undefined }) };
    }
    return null;
  }

  if (!args.includes("-c")) {
    return {
      exe: localBash,
      args: args.filter((a) => !["-l", "--login", "-i", "--interactive", "--norc", "--noprofile"].includes(a)),
      opts: cleanLocalBashOpts(opts, localBash),
    };
  }

  let ci = args.indexOf("-c") + 1;
  while (ci < args.length && args[ci].startsWith("-") && args[ci] !== "-") ci++;
  const cmd = args[ci];
  if (!cmd) return null;

  if (adapter.isHostInternalCmd(cmd)) {
    return { exe: localBash, args: ["-c", cmd], opts: cleanLocalBashOpts(opts, localBash) };
  }

  const evalCmd = extractEval(cmd);
  const actualCmd = evalCmd || cmd;
  const rc = getRemoteCwd();
  return {
    exe: "__sftp_exec__",
    args: ["cd '" + rc + "' && " + actualCmd],
    opts: Object.assign({}, opts, { cwd: undefined }),
  };
}

// Returns the remote command string to run via sftpExec, or null to pass through to native.
// For host-internal commands (adapter.isHostInternalCmd), route to localBash instead of native
// sh — on Windows with platform=linux, native sh resolves to WSL which can't access Windows
// paths, causing security hooks and shell-snapshots to fail.
function routeExecCommand(command, file, args, opts, adapter, getRemoteCwd) {
  if (command != null) {
    if (adapter.isHostInternalCmd(command)) {
      // Route to local bash, not native sh (which may be WSL).
      return { __localBash: true, cmd: command };
    }
    const rc = getRemoteCwd();
    return "cd '" + rc + "' && " + String(command);
  }

  const fileStr = String(file || "");
  const argList = Array.isArray(args) ? args : [];

  // ripgrep (Grep/Glob tools): route to remote when cwd or any arg is a remote path.
  // Same interception as wrapSpawn's rg branch — qoder's PSi uses execFile (g9c), not
  // spawn, when egn() returns system mode (no argv0), so the rg call reaches us here
  // via cp.execFile, not cp.spawn. Without this, rg runs as a native Windows binary
  // that can't see remote paths → ENOENT or empty results.
  if (isRg(fileStr)) {
    const cwd = opts && opts.cwd;
    const cwdRemote = cwd && isRemote(String(cwd));
    const argsRemote = argList.some((a) => isRemote(String(a)));
    if (cwdRemote || argsRemote) {
      const rc = cwdRemote ? toRemote(String(cwd)) : getRemoteCwd();
      return buildRgRemoteCmd(argList, rc);
    }
  }

  if (isBash(fileStr) && argList.includes("-c")) {
    let ci = argList.indexOf("-c") + 1;
    while (ci < argList.length && argList[ci].startsWith("-") && argList[ci] !== "-") ci++;
    const cmd = argList[ci];
    if (!cmd) return null;
    if (adapter.isHostInternalCmd(cmd)) {
      return { __localBash: true, cmd };
    }
    const rc = getRemoteCwd();
    return "cd '" + rc + "' && " + String(cmd);
  }

  // Non-bash binary: route to remote if the exe itself is a remote path, any arg is
  // remote, or it's a bare-name Linux binary not found locally (getconf, ps).
  if (shouldRouteNonBash(fileStr, argList)) {
    return buildRemoteCmd(fileStr, argList);
  }
  return null;
}

function makeExecResultChild(cmd, opts, callback) {
  // cp.execFile and cp.exec default to utf8 (return strings), unlike cp.spawn which
  // defaults to Buffer. qoder calls .trim() on the callback's stdout in many places,
  // so defaulting to utf8 here is required to match native behavior and avoid
  // "t.trim is not a function" when no explicit encoding is passed.
  const enc = (opts && (typeof opts === "string" ? opts : opts.encoding)) || "utf8";
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({ write(c, e, d) { d(); } });
  child.pid = -1;
  child.unref = () => child;
  child.ref = () => child;
  child.kill = () => true;

  const finish = (err, r) => {
    if (err) {
      const se = Buffer.from(err.message + "\n");
      child.stderr.push(se);
      child.stderr.push(null);
      child.stdout.push(null);
      child.emit("exit", 127, null);
      child.emit("close", 127, null);
      if (callback) callback(err, enc ? "" : Buffer.alloc(0), enc ? se.toString(enc) : se);
      return;
    }
    child.stdout.push(r.stdout);
    child.stdout.push(null);
    child.stderr.push(r.stderr);
    child.stderr.push(null);
    const ec = r.exitCode || 0;
    child.emit("exit", ec, null);
    child.emit("close", ec, null);
    if (callback) {
      const out = enc ? r.stdout.toString(enc) : r.stdout;
      const serr = enc ? r.stderr.toString(enc) : r.stderr;
      if (ec !== 0) {
        const ferr = new Error("Command failed: " + cmd + "\n" + r.stderr.toString("utf8"));
        ferr.code = ec;
        ferr.status = ec;
        ferr.stdout = r.stdout;
        ferr.stderr = r.stderr;
        callback(ferr, out, serr);
      } else {
        callback(null, out, serr);
      }
    }
  };

  // PREFER ASYNC so parallel execFile (e.g. rg in exec_file mode) doesn't block.
  if (global.__sftpExecAsync) {
    global.__sftpExecAsync(cmd).then((r) => {
      _trace("execFile/exec ASYNC result: cmd="+JSON.stringify(String(cmd).slice(0,80))+" stdoutLen="+(r&&r.stdout?r.stdout.length:0)+" exit="+(r?r.exitCode:"?")+" hasCb="+(!!callback));
      finish(null, r);
    }, (e) => {
      _trace("execFile/exec ASYNC error: "+e.message);
      finish(e, null);
    });
    return child;
  }
  // SYNC FALLBACK.
  process.nextTick(() => {
    let r;
    try {
      r = global.__sftpExec(cmd);
    } catch (err) {
      finish(err, null);
      return;
    }
    finish(null, r);
  });
  return child;
}

function execResultSync(cmd, opts) {
  if (!global.__sftpExec) return null;
  const r = global.__sftpExec(cmd);
  if (r.exitCode !== 0) {
    const err = new Error("Command failed: " + cmd + "\n" + r.stderr.toString("utf8"));
    err.status = r.exitCode;
    err.code = r.exitCode;
    err.stdout = r.stdout;
    err.stderr = r.stderr;
    throw err;
  }
  // cp.execFileSync defaults to utf8 (returns string), like execFile.
  const enc = (opts && (typeof opts === "string" ? opts : opts.encoding)) || "utf8";
  return r.stdout.toString(enc);
}

function apply(adapter, getRemoteCwd) {
  const localBash = adapter.getLocalBash();
  const _spawn = cp.spawn;
  const _spawnSync = cp.spawnSync;
  const _exec = cp.exec;
  const _execSync = cp.execSync;
  const _execFile = cp.execFile;
  const _execFileSync = cp.execFileSync;

  cp.spawn = function (exe, args, opts) {
    _trace("spawn CALL: exe="+JSON.stringify(String(exe||"").slice(0,50))+" a0="+JSON.stringify(String(args&&args[0]||"").slice(0,30))+" a1="+JSON.stringify(String(args&&args[1]||"").slice(0,60))+" stdio="+_stdioDesc(opts));
    if (exe === "__sftp_exec__") return makeSftpExecChild(args[0], opts);

    const _exeStr = String(exe || "");
    if (adapter.shouldInterceptRuntimeBinary(_exeStr)) {
      _trace("spawn -> runtimeInfo intercept");
      return makeRuntimeInfoChild();
    }

    const w = wrapSpawn(exe, args, opts, adapter, getRemoteCwd);
    if (w) {
      if (w.exe === "__sftp_exec__") {
        _trace("spawn -> sftpExec: cmd="+JSON.stringify(String(w.args[0]||"").slice(0,80)));
        return makeSftpExecChild(w.args[0], w.opts);
      }
      _trace("spawn -> localBash: exe="+JSON.stringify(String(w.exe).slice(0,50)));
      return _spawn.call(cp, w.exe, w.args, w.opts);
    }
    _trace("spawn -> passthrough native");
    return _spawn.call(cp, exe, args, opts);
  };

  cp.spawnSync = function (exe, args, opts) {
    _trace("spawnSync CALL: exe="+JSON.stringify(String(exe||"").slice(0,50))+" a0="+JSON.stringify(String(args&&args[0]||"").slice(0,30))+" a1="+JSON.stringify(String(args&&args[1]||"").slice(0,60))+" stdio="+_stdioDesc(opts)+" enc="+(opts&&(typeof opts==="string"?opts:opts.encoding)||"default"));
    const w = wrapSpawn(exe, args, opts, adapter, getRemoteCwd);
    if (w && w.exe === "__sftp_exec__") {
      if (global.__sftpExec) {
        const _ssT = Date.now();
        try {
          const r = global.__sftpExec(w.args[0]);
          _trace("spawnSync result: cmd="+JSON.stringify(String(w.args[0]||"").slice(0,60))+" -> "+(Date.now()-_ssT)+"ms stdoutLen="+r.stdout.length+" exit="+(r.exitCode||0));
          const enc = opts && (typeof opts === "string" ? opts : opts.encoding);
          const out = enc ? r.stdout.toString(enc) : r.stdout;
          const err = enc ? r.stderr.toString(enc) : r.stderr;
          return { status: r.exitCode || 0, stdout: out, stderr: err, pid: 0 };
        } catch (e) {
          _trace("spawnSync ERR: "+e.message);
          return { status: 127, stdout: Buffer.alloc(0), stderr: Buffer.from(e.message + "\n"), pid: 0 };
        }
      }
      _trace("spawnSync -> sftpExec unavailable");
      return {
        status: 127,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("SFTP exec unavailable (worker not ready) — refused\n"),
        pid: 0,
      };
    }
    _trace("spawnSync -> "+(w?"localBash":"passthrough"));
    return w ? _spawnSync.call(cp, w.exe, w.args, w.opts) : _spawnSync.call(cp, exe, args, opts);
  };

  cp.exec = function (command, opts, callback) {
    let _opts = opts;
    let _cb = callback;
    if (typeof opts === "function") {
      _cb = opts;
      _opts = undefined;
    }
    _trace("exec CALL: cmd="+JSON.stringify(String(command||"").slice(0,80))+" stdio="+_stdioDesc(_opts));
    const cmd = routeExecCommand(command, null, null, _opts, adapter, getRemoteCwd);
    if (cmd !== null) {
      if (typeof cmd === "object" && cmd.__localBash) {
        _trace("exec -> localBash");
        const o = localBashExecOpts(_opts, localBash);
        return _exec.call(cp, cmd.cmd, o, _cb);
      }
      _trace("exec -> sftpExec: "+JSON.stringify(String(cmd).slice(0,80)));
      return makeExecResultChild(cmd, _opts, _cb);
    }
    _trace("exec -> passthrough");
    return _exec.call(cp, command, _opts, _cb);
  };

  cp.execSync = function (command, opts) {
    _trace("execSync CALL: cmd="+JSON.stringify(String(command||"").slice(0,80)));
    const cmd = routeExecCommand(command, null, null, opts, adapter, getRemoteCwd);
    if (cmd !== null) {
      if (typeof cmd === "object" && cmd.__localBash) {
        _trace("execSync -> localBash");
        const o = localBashExecOpts(opts, localBash);
        return _execSync.call(cp, cmd.cmd, o);
      }
      const r = execResultSync(cmd, opts);
      _trace("execSync result: "+JSON.stringify(String(cmd).slice(0,60))+" stdoutLen="+(r?Buffer.byteLength(r):0));
      if (r !== null) return r;
    }
    _trace("execSync -> passthrough");
    return _execSync.call(cp, command, opts);
  };

  cp.execFile = function (file, args, opts, callback) {
    let _args = args;
    let _opts = opts;
    let _cb = callback;
    if (typeof args === "function") {
      _cb = args;
      _args = undefined;
      _opts = undefined;
    } else if (typeof opts === "function") {
      _cb = opts;
      _opts = undefined;
    }
    const argList = Array.isArray(_args) ? _args : [];
    _trace("execFile CALL: file="+JSON.stringify(String(file||"").slice(0,50))+" a0="+JSON.stringify(String(argList[0]||"").slice(0,30))+" a1="+JSON.stringify(String(argList[1]||"").slice(0,60))+" stdio="+_stdioDesc(_opts));
    const cmd = routeExecCommand(null, file, argList, _opts, adapter, getRemoteCwd);
    if (cmd !== null) {
      if (typeof cmd === "object" && cmd.__localBash) {
        _trace("execFile -> localBash");
        const o = localBashExecOpts(_opts, localBash);
        return _exec.call(cp, cmd.cmd, o, _cb);
      }
      _trace("execFile -> sftpExec: "+JSON.stringify(String(cmd).slice(0,80)));
      return makeExecResultChild(cmd, _opts, _cb);
    }
    _trace("execFile -> passthrough");
    return _execFile.call(cp, file, _args || [], _opts, _cb);
  };

  cp.execFileSync = function (file, args, opts) {
    const argList = Array.isArray(args) ? args : [];
    _trace("execFileSync CALL: file="+JSON.stringify(String(file||"").slice(0,50))+" a0="+JSON.stringify(String(argList[0]||"").slice(0,30))+" a1="+JSON.stringify(String(argList[1]||"").slice(0,60)));
    const cmd = routeExecCommand(null, file, argList, opts, adapter, getRemoteCwd);
    if (cmd !== null) {
      if (typeof cmd === "object" && cmd.__localBash) {
        _trace("execFileSync -> localBash");
        const o = localBashExecOpts(opts, localBash);
        return _execSync.call(cp, cmd.cmd, o);
      }
      const _efT = Date.now();
      const r = execResultSync(cmd, opts);
      process.stderr.write("[launcher] execFileSync " + file + " -> " + (Date.now()-_efT) + "ms\n");
      if (r !== null) return r;
    }
    return _execFileSync.call(cp, file, args, opts);
  };

  // Lock cp methods against graceful-fs / other module clobbering (same pattern as fs-bridge).
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
    try {
      const patched = cp[name];
      Object.defineProperty(cp, name, {
        get: () => patched,
        set: () => {},
        configurable: false,
        enumerable: true,
      });
    } catch (e) {}
  }
}

module.exports = { apply };
