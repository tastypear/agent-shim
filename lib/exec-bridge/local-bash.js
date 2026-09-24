function ensureBashPath(env, localBash) {
  const MSYS_BINS = "/usr/bin:/bin:/mingw64/bin";
  const cur = env.PATH;
  if (!cur) {
    env.PATH = MSYS_BINS;
  } else if (!String(cur).includes("/usr/bin")) {
    env.PATH = MSYS_BINS + ":" + cur;
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
  const o = Object.assign({}, opts, { shell: localBash, windowsHide: true });
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
