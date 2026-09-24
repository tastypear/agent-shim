const { isRemote, toRemote } = require("../classifier");
const { cleanLocalBashOpts } = require("./local-bash");

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

const _existsSync = require("fs").existsSync;
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

function wrapSpawn(exe, args, opts, adapter, getRemoteCwd) {
  if (!exe || !args) return null;
  const exeStr = String(exe);
  const localBash = adapter.getLocalBash();

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

function routeExecCommand(command, file, args, opts, adapter, getRemoteCwd) {
  if (command != null) {
    if (adapter.isHostInternalCmd(command)) {
      return { __localBash: true, cmd: command };
    }
    const rc = getRemoteCwd();
    return "cd '" + rc + "' && " + String(command);
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

  if (shouldRouteNonBash(fileStr, argList)) {
    return buildRemoteCmd(fileStr, argList);
  }
  return null;
}

module.exports = {
  extractEval, isBash, shellQuote, findLocalExe, isBareName, isWindowsExeName,
  isRg, buildRgRemoteCmd, shouldRouteNonBash, buildRemoteCmd, wrapSpawn, routeExecCommand,
};
