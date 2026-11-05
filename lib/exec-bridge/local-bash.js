function ensureBashPath(env, localBash) {
  // Always put the MSYS bins first. The old heuristic (skip when the PATH
  // string contains "/usr/bin") was fragile: Windows paths written with
  // forward slashes (C:/.../git/usr/bin) and POSIX-style PATHs both contain
  // the substring yet may not resolve to the local MSYS root — leaving bash
  // with an unresolvable PATH where no external command (grep, env, find)
  // can be found while builtins still work. Prepended duplicates are harmless.
  const MSYS_BINS = "/usr/bin:/bin:/mingw64/bin";
  const cur = env.PATH;
  if (!cur || !String(cur).startsWith("/usr/bin")) {
    env.PATH = MSYS_BINS + (cur ? ":" + cur : "");
  }
}

// qoder captures Bash-tool stdout/stderr by opening the task .output file with POSIX
// O_WRONLY|O_APPEND|O_CREAT and passing the numeric fd as child stdio (stdio=["pipe",fd,fd]).
// On Windows that handle is append-only, which MSYS bash cannot write (see sync-ops
// __reopenAppendStdioFd). Swap recorded append-mode fds for re-opened full-write handles
// before handing the spawn to the local bash. Call closeReopenedFds() after the spawn.
function reopenAppendStdio(opts) {
  const stdio = opts.stdio;
  const reopen = typeof global.__reopenAppendStdioFd === "function" ? global.__reopenAppendStdioFd : null;
  if (!reopen || !Array.isArray(stdio)) return null;
  const newStdio = stdio.slice();
  const opened = [];
  let changed = false;
  for (const idx of [1, 2]) {
    if (idx >= stdio.length) continue;
    const cur = stdio[idx];
    if (typeof cur !== "number" || cur < 0) continue;
    let nfd = opened.find((o) => o.src === cur);
    if (nfd === undefined) {
      const r = reopen(cur);
      if (!r) continue;
      nfd = { src: cur, fd: r.fd };
      opened.push(nfd);
    }
    newStdio[idx] = nfd.fd;
    changed = true;
  }
  if (!changed) return null;
  opts.stdio = newStdio;
  return opened.map((o) => o.fd);
}

function closeReopenedFds(fds) {
  if (!Array.isArray(fds)) return;
  for (const fd of fds) {
    try {
      require("fs").closeSync(fd);
    } catch (e) {}
  }
}

function cleanLocalBashOpts(opts, localBash) {
  const cleaned = Object.assign({}, opts, {
    cwd: undefined,
    detached: false,
    windowsHide: true,
  });
  if (!cleaned.env) cleaned.env = Object.assign({}, process.env);
  else cleaned.env = Object.assign({}, cleaned.env);
  delete cleaned.env.HOME;
  ensureBashPath(cleaned.env, localBash);
  const reopened = reopenAppendStdio(cleaned);
  if (reopened) cleaned.__reopenedFds = reopened;
  return cleaned;
}

function localBashExecOpts(opts, localBash) {
  // Match cleanLocalBashOpts (spawn path): strip cwd — qoder passes a remote or
  // virtual workspace path that may not exist locally, which makes the local
  // bash fail with ENOENT (the caller then sees an error, zero output).
  const o = Object.assign({}, opts, {
    cwd: undefined,
    detached: false,
    shell: localBash,
    windowsHide: true,
  });
  if (!o.env) o.env = Object.assign({}, process.env);
  else o.env = Object.assign({}, o.env);
  delete o.env.HOME;
  ensureBashPath(o.env, localBash);
  return o;
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

module.exports = { cleanLocalBashOpts, localBashExecOpts, ensureBashPath, writeToStdio, reopenAppendStdio, closeReopenedFds };
