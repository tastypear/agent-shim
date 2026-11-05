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

module.exports = { cleanLocalBashOpts, localBashExecOpts, ensureBashPath, writeToStdio };
