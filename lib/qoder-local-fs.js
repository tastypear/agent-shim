// lib/qoder-local-fs.js — top-level fs patch routing workspace .qoder to a local mirror.
//
// Installed AFTER the fs-bridge (SSH) or remote-fs-node + http-cache (HTTP) patch, so it wraps
// outermost: it rewrites <virtualCwd>/.qoder/<rest> → <qoderHome>/projects/<flat>/.qoder/<rest>
// (a drive-qualified local path) BEFORE the bridge classifies it. The bridge then sees a local
// path → native fs on the mirror. This keeps project config (settings, skills, commands, agents,
// …) on local disk, co-located with session history, so it's fast and leaves no persistent qoder
// traces on the remote. worktrees/ is excluded — those are exec working dirs (git worktree add
// runs remote; the session chdirs into them) and must stay on the remote filesystem.
//
// <flat> mirrors qoder's project identifier: the virtual cwd flattened (non-alphanumerics → "-"),
// e.g. /◦172.23.176.73∶8765/home/tastypear → --172-23-176-73-8765-home-tastypear. <qoderHome>
// matches qoder's* getGlobalConfigDir(): QODER_CLI_HOME || ~/.qoder. Disable with DISABLE_QODER_LOCAL=1.
// See knowledge-base/qoder-patches.md.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { qoderLocalMirror, toRemote } = require("./classifier");

const ENABLED = process.env.DISABLE_QODER_LOCAL !== "1";
const DEBUG = process.env.AGENT_SHIM_QODER_LOCAL_DEBUG === "1";

function qoderHome() {
  return process.env.QODER_CLI_HOME || path.join(os.homedir(), ".qoder");
}

function mirrorDir(virtualCwd) {
  return path.join(qoderHome(), "projects", virtualCwd.replace(/[^A-Za-z0-9]/g, "-"), ".qoder");
}

// Cached remote-cwd base for stripped-form detection. Recomputed only when process.cwd() changes
// (chdir), so the per-op cost is a string identity check, not a toRemote round-trip.
let _cwd = "", _remoteBase = null, _vcwd = null;
function remoteBase() {
  const cwd = process.cwd();
  if (cwd !== _cwd) {
    _cwd = cwd;
    _vcwd = cwd;
    _remoteBase = cwd.charCodeAt(1) === 0x25E6 ? toRemote(cwd) + "/.qoder" : null;
  }
  return _remoteBase;
}

// Rewrite a workspace .qoder path to its local mirror path. Handles two forms:
//  - Prefixed: /◦host∶port/vcwd/.qoder/<rest>  (path.join-built; ◦ prefix intact)
//  - Stripped: /remoteCwd/.qoder/<rest>          (path.resolve-built; path-bridge stripped the prefix)
// Identity for all other paths. worktrees/ excluded (exec working dirs stay remote).
function resolveFsPath(p) {
  if (typeof p !== "string") return p;
  let m = qoderLocalMirror(p);
  if (!m) {
    // Stripped form: path-bridge's path.resolve strips the ◦ prefix (toRemote) for multi-arg
    // calls, so fs sees the bare remote path. Match it against toRemote(cwd)+"/.qoder" and
    // recover the virtual cwd (process.cwd(), prefix intact) for the <flat> bucket key.
    const norm = p.replace(/\\/g, "/");
    if (norm.charCodeAt(0) === 47 && norm.charCodeAt(1) !== 0x25E6 && !/^[a-zA-Z]:/.test(norm)) {
      const base = remoteBase();
      if (base) {
        if (norm === base) {
          m = { virtualCwd: _vcwd, rest: "" };
        } else if (norm.startsWith(base + "/")) {
          const rest = norm.slice(base.length + 1);
          if (rest !== "worktrees" && !rest.startsWith("worktrees/")) m = { virtualCwd: _vcwd, rest };
        }
      }
    }
  }
  if (!m) {
    if (DEBUG && p.indexOf(".qoder") >= 0) console.error("[qoder-local] MISS " + p + " (cwd=" + process.cwd() + " base=" + remoteBase() + ")");
    return p;
  }
  const out = path.join(mirrorDir(m.virtualCwd), m.rest);
  if (DEBUG) console.error("[qoder-local] " + p + " -> " + out);
  return out;
}

// fs methods that take one or more path arguments (not fd-based: read/write/close/fstat/… are
// excluded — their first arg is a file descriptor, not a path). For each, rewrite every string
// arg via resolveFsPath (identity for non-.qoder paths, so local/remote paths are unaffected).
const PATH_METHODS = [
  "existsSync", "statSync", "lstatSync", "readFileSync", "writeFileSync", "readdirSync",
  "mkdirSync", "unlinkSync", "accessSync", "renameSync", "rmSync", "copyFileSync",
  "appendFileSync", "realpathSync", "rmdirSync", "readlinkSync", "symlinkSync",
  "truncateSync", "chmodSync", "chownSync", "utimesSync", "linkSync", "openSync",
  "createReadStream", "createWriteStream", "watch", "watchFile",
  "readFile", "writeFile", "stat", "lstat", "readdir", "access", "mkdir", "unlink",
  "rename", "copyFile", "appendFile", "rm", "realpath", "rmdir", "readlink", "symlink",
  "truncate", "chmod", "chown", "utimes", "link", "open", "opendir", "cp",
];
const PROMISE_METHODS = PATH_METHODS.filter(
  (k) => !k.endsWith("Sync") && k !== "createReadStream" && k !== "createWriteStream" && k !== "watch" && k !== "watchFile"
);

let patched = false;
function patchFs() {
  if (patched || !ENABLED) return;
  patched = true;
  let n = 0;
  const wrap = (obj, k) => {
    const orig = obj[k];
    if (typeof orig !== "function") return;
    obj[k] = function (...args) {
      for (let i = 0; i < args.length; i++) {
        if (typeof args[i] === "string") args[i] = resolveFsPath(args[i]);
      }
      return orig.apply(this, args);
    };
    n++;
  };
  for (const k of PATH_METHODS) wrap(fs, k);
  if (fs.promises) for (const k of PROMISE_METHODS) wrap(fs.promises, k);
  // qoder imports the separate fs/promises module (which remote-fs-node patches via
  // _patchFsPromisesModule); wrap it too so .qoder rewrites aren't bypassed.
  try {
    const fsp = require("fs/promises");
    if (fsp && fsp !== fs.promises) for (const k of PROMISE_METHODS) wrap(fsp, k);
  } catch (_) {}
  if (DEBUG) console.error("[qoder-local] patchFs wrapped " + n + " methods (fs + fs.promises + fs/promises)");
}

// install(virtualCwd): patch fs (idempotent) and pre-create the mirror .qoder dir for this
// connection so first writes don't ENOENT (qoder also mkdirs itself; this covers writes that
// assume the dir exists). Called once per connection after the fs bridge is set up.
function install(virtualCwd) {
  if (!ENABLED) return;
  patchFs();
  if (DEBUG) console.error("[qoder-local] install virtualCwd=" + virtualCwd + " process.cwd=" + process.cwd());
  if (typeof virtualCwd === "string" && virtualCwd.charCodeAt(1) === 0x25E6) {
    try { fs.mkdirSync(mirrorDir(virtualCwd), { recursive: true }); } catch (_) {}
  }
}

module.exports = { install, resolveFsPath };
