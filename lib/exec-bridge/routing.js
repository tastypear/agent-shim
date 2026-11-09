const { isRemote, toRemote } = require("../classifier");
const { cleanLocalBashOpts } = require("./local-bash");
const _log = require("../logger");
const logger = _log.child("exec.route");
const _fs = require("fs");
const _os = require("os");
const _path = require("path");

// Route trace: in remote sessions, record every bash spawn and the branch taken,
// so a silent local execution can be traced back to the spawn that produced it.
// Disabled for local profiles (AGENT_SHIM_REMOTE is set by lib/index.js).
const _routeLogFile = process.env.AGENT_SHIM_ROUTE_LOG || _path.join(_os.tmpdir(), "agent-shim-route-trace.log");
let _routeLogOff = false;
function routeTrace(obj) {
  if (_routeLogOff || process.env.AGENT_SHIM_REMOTE !== "1") return;
  try {
    _fs.appendFileSync(_routeLogFile, JSON.stringify(Object.assign({ ts: new Date().toISOString(), pid: process.pid }, obj)) + "\n");
  } catch (e) { _routeLogOff = true; }
}

// Extracts the argument of `eval <WORD>` from a bash -c command string.
// qoder wraps user commands as `eval 'USERCMD 2>&1; echo "rc=True"'`, shell-quoting
// any single quotes inside USERCMD via the `'"'"'` (or `'\''`) idiom. A naive
// `/eval '(.+?)'/` regex stops at the first `'` inside that escape sequence and
// truncates the command (e.g. `cat ` → `cat` blocks on stdin → 30s SFTP timeout).
// This parser walks one bash word (single/double/unquoted segments) so the full
// argument is recovered and unescaped.
function extractEval(cmd) {
  const m = cmd.match(/\beval\s+/);
  if (!m) return null;
  let i = m.index + m[0].length;
  const n = cmd.length;
  let out = "";
  while (i < n) {
    const ch = cmd[i];
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) { out += cmd.slice(i + 1); break; }
      out += cmd.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      const end = cmd.indexOf('"', i + 1);
      if (end < 0) { out += cmd.slice(i + 1); break; }
      out += cmd.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === "\\") {
      out += cmd[i + 1] || "";
      i += 2;
      continue;
    }
    if (/\s|[<>|;&()]/.test(ch)) break;
    out += ch;
    i++;
  }
  return out;
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

// Node spawn/exec replace the child env with opts.env wholesale. Remote exec
// can't replace the server-side env, so approximate with an export prefix of
// the DELTA vs the ambient env: vars the caller added or changed get exported,
// vars equal to ambient are skipped (the remote env supplies its own PATH —
// exporting the host's Windows-style PATH would break remote command lookup).
// Removals (ambient var absent from opts.env) can't be expressed; they leak.
function envPrefix(opts) {
  const env = opts && opts.env;
  if (!env || typeof env !== "object") return "";
  const keys = Object.keys(env).filter((k) => process.env[k] !== env[k]);
  if (!keys.length) return "";
  return keys.map((k) => "export " + shellQuote(k) + "=" + shellQuote(String(env[k])) + "; ").join("");
}

const _existsSync = require("fs").existsSync;
const _exeCache = new Map();
function findLocalExe(name) {
  if (_exeCache.has(name)) return _exeCache.get(name);
  let found = null;
  try {
    // Host PATH in Windows format — process.env.PATH may have been converted to
    // MSYS form by platform.js (for the faked-linux shell); exe lookup needs the original.
    const PATH = require("../platform").originalPath() || process.env.PATH || "";
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

function isRg(exeStr) {
  const norm = String(exeStr).replace(/\\/g, "/");
  return norm === "rg" || norm === "rg.exe" || norm.endsWith("/rg") || norm.endsWith("/rg.exe");
}

function buildRgRemoteCmd(argList, remoteCwd) {
  const quoted = argList.map((a) => {
    const s = String(a);
    return shellQuote(isRemote(s) ? toRemote(s) : s);
  });
  return "cd " + shellQuote(remoteCwd) + " && rg " + quoted.join(" ");
}

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

// Index of the bash short-option cluster that contains 'c' ("-c", "-lc", "-ic", ...).
// Only options BEFORE the first operand are considered, matching bash's own parsing,
// so a script operand that happens to be "-c" is not mistaken for the option.
function cFlagIndex(argList) {
  for (let k = 0; k < argList.length; k++) {
    const a = String(argList[k]);
    if (a === "--" || !a.startsWith("-") || a === "-") break;
    if (/^-[A-Za-z]{1,5}$/.test(a) && a.includes("c")) return k;
  }
  return -1;
}

function cmdAfterFlag(argList, idx) {
  let ci = idx + 1;
  while (ci < argList.length && String(argList[ci]).startsWith("-") && argList[ci] !== "-") ci++;
  return argList[ci];
}

// Run `bash <args...>` on the remote host. Used for script launches that carry no
// -c option: these previously spawned the LOCAL bash, so a remote session could
// silently execute commands on the host (qoder's PTY launcher `bash -lc "<cmd>"`
// lands here when its shell restarts).
function buildBashRemoteCmd(argList, remoteCwd, opts) {
  const quoted = argList.map((a) => shellQuote(String(a)));
  return envPrefix(opts) + "cd " + shellQuote(remoteCwd) + " && bash " + quoted.join(" ");
}

function wrapSpawn(exe, args, opts, adapter, getRemoteCwd) {
  if (!exe || !args) return null;
  const exeStr = String(exe);
  const localBash = adapter.getLocalBash();

  if (isBash(exeStr) && Array.isArray(args)) {
    routeTrace({ ev: "spawn", exe: exeStr, args: args.map((a) => String(a).slice(0, 160)).slice(0, 4) });
  }

  if (!isBash(exeStr)) {
    const argList = Array.isArray(args) ? args : [];

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

  // A -c cluster ("-c", "-lc", ...) means the next word is the command.
  const cIdx = cFlagIndex(args);
  if (cIdx < 0) {
    const nonFlag = args.filter((a) => typeof a === "string" && a !== "-" && !a.startsWith("-"));
    const inner = nonFlag.join(" ");
    if (!nonFlag.length || adapter.isHostInternalCmd(inner)) {
      if (nonFlag.length) logger.trace("bash without -c kept local (host-internal): " + JSON.stringify(inner.slice(0, 100)));
      routeTrace({ ev: "route", branch: nonFlag.length ? "local-host-internal" : "local-interactive", exe: exeStr });
      return {
        exe: localBash,
        args: args.filter((a) => !["-l", "--login", "-i", "--interactive", "--norc", "--noprofile"].includes(a)),
        opts: cleanLocalBashOpts(opts, localBash),
      };
    }
    const rc = getRemoteCwd();
    logger.info("bash without -c routed remote: " + JSON.stringify(inner.slice(0, 100)));
    routeTrace({ ev: "route", branch: "remote-bash", cmd: inner.slice(0, 160) });
    return {
      exe: "__sftp_exec__",
      args: [buildBashRemoteCmd(args, rc, opts)],
      opts: Object.assign({}, opts, { cwd: undefined }),
    };
  }

  const cmd = cmdAfterFlag(args, cIdx);
  if (!cmd) return null;

  if (adapter.isHostInternalCmd(cmd)) {
    routeTrace({ ev: "route", branch: "local-host-internal-c", cmd: String(cmd).slice(0, 160) });
    return { exe: localBash, args: ["-c", cmd], opts: cleanLocalBashOpts(opts, localBash) };
  }

  const evalCmd = extractEval(cmd);
  const actualCmd = evalCmd != null ? evalCmd : cmd;
  const rc = getRemoteCwd();
  routeTrace({ ev: "route", branch: "remote-c", cmd: String(actualCmd).slice(0, 160) });
  return {
    exe: "__sftp_exec__",
    args: [envPrefix(opts) + "cd '" + rc + "' && " + actualCmd],
    opts: Object.assign({}, opts, { cwd: undefined }),
  };
}

function routeExecCommand(command, file, args, opts, adapter, getRemoteCwd) {
  if (command != null) {
    if (adapter.isHostInternalCmd(command)) {
      return { __localBash: true, cmd: command };
    }
    const rc = getRemoteCwd();
    return envPrefix(opts) + "cd '" + rc + "' && " + String(command);
  }

  const fileStr = String(file || "");
  const argList = Array.isArray(args) ? args : [];

  if (isRg(fileStr)) {
    const cwd = opts && opts.cwd;
    const cwdRemote = cwd && isRemote(String(cwd));
    const argsRemote = argList.some((a) => isRemote(String(a)));
    if (cwdRemote || argsRemote) {
      const rc = cwdRemote ? toRemote(String(cwd)) : getRemoteCwd();
      return buildRgRemoteCmd(argList, rc);
    }
  }

  if (isBash(fileStr)) {
    routeTrace({ ev: "spawn-exec", exe: fileStr, args: argList.map((a) => String(a).slice(0, 160)).slice(0, 4) });
    const cIdx = cFlagIndex(argList);
    if (cIdx >= 0) {
      const cmd = cmdAfterFlag(argList, cIdx);
      if (!cmd) return null;
      if (adapter.isHostInternalCmd(cmd)) {
        routeTrace({ ev: "route", branch: "local-host-internal-c", cmd: String(cmd).slice(0, 160) });
        return { __localBash: true, cmd };
      }
      const rc = getRemoteCwd();
      routeTrace({ ev: "route", branch: "remote-c", cmd: String(cmd).slice(0, 160) });
      return envPrefix(opts) + "cd '" + rc + "' && " + String(cmd);
    }
    const nonFlag = argList.filter((a) => typeof a === "string" && a !== "-" && !a.startsWith("-"));
    const inner = nonFlag.join(" ");
    if (nonFlag.length && !adapter.isHostInternalCmd(inner)) {
      logger.info("execFile bash without -c routed remote: " + JSON.stringify(inner.slice(0, 100)));
      routeTrace({ ev: "route", branch: "remote-bash", cmd: inner.slice(0, 160) });
      return buildBashRemoteCmd(argList, getRemoteCwd(), opts);
    }
  }

  if (shouldRouteNonBash(fileStr, argList)) {
    return buildRemoteCmd(fileStr, argList);
  }
  return null;
}

module.exports = {
  extractEval, isBash, shellQuote, findLocalExe, isBareName, isWindowsExeName,
  isRg, buildRgRemoteCmd, shouldRouteNonBash, buildRemoteCmd, wrapSpawn, routeExecCommand,
  cFlagIndex, buildBashRemoteCmd,
};
