// lib/config.js
// Configuration loader. No host-specific/private values are hardcoded — all remote
// connection settings come from env vars, a user config file, or remote-default.json.
//
// Search path (highest → lowest, first existing file wins):
//   1. AGENT_SHIM_CONFIG env (explicit path; error if set but file missing).
//      REMOTE_BRIDGE_CONFIG accepted as a deprecated alias.
//   2. cwd/.agent-shim.json
//   3. LAUNCHER_DIR/.agent-shim.json
//   4. ~/.config/agent-shim/config.json   (XDG — survives project dir changes)
//   5. cwd/.remote-bridge.json            (deprecated, warns)
//   6. LAUNCHER_DIR/.remote-bridge.json   (deprecated, warns)
//   7. remote-default.json                (tracked, generic defaults only)
//
// Per-field env vars (REMOTE_BRIDGE_HOST etc.) override file values. host, user,
// and vcwd are required. Unknown config keys warn; type mismatches throw.
//
// Probe cache is isolated per connection: .agent-shim-cache-<sha256(host:user:port)[:12]>.json
// under paths.cachePath (a directory) or LAUNCHER_DIR, so two servers never share a cache.
//
// All values are resolved at require() time and frozen into a single object.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const logger = require("./logger").child("config");

const LAUNCHER_DIR = path.join(__dirname, "..");
const DEFAULT_CONFIG_PATH = path.join(LAUNCHER_DIR, "remote-default.json");

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Merge top-level sections (ssh, paths, env, …) from defaults ← user. User keys
// win within each shared section; sections present in only one side are kept.
function mergeConfig(defaults, user) {
  const out = {};
  for (const key of new Set([...Object.keys(defaults), ...Object.keys(user)])) {
    const dv = defaults[key];
    const uv = user[key];
    out[key] =
      isPlainObject(dv) && isPlainObject(uv) ? { ...dv, ...uv } : uv !== undefined ? uv : dv;
  }
  return out;
}

// ===== Validation (hand-written, no schema dependency) =====
const TYPE_CHECKS = {
  string: (v) => typeof v === "string",
  int: (v) => Number.isInteger(v) || (typeof v === "string" && /^\d+$/.test(v.trim())),
  bool: (v) => typeof v === "boolean" || v === "true" || v === "false",
  object: isPlainObject,
};
const SCHEMA = {
  transport: "string",
  ssh: { keys: { host: "string", user: "string", port: "int", keyPath: "string" } },
  http: { keys: { host: "string", port: "int", token: "string", tls: "bool" } },
  paths: { keys: { vcwd: "string", ssh2: "string", localBash: "string", osRelease: "string", socksProxy: "string", cachePath: "string", home: "string", dataDir: "string", cliHome: "string", isolateData: "string", nodeVersion: "string", arch: "string" } },
  env: {},
  keepalive: "int",
  readyTimeout: "int",
  disableTelemetry: "bool",
  byok: "bool",
};

function validate(obj, where) {
  for (const key of Object.keys(obj)) {
    const spec = SCHEMA[key];
    if (!spec) {
      logger.warn("unknown config key '" + key + "' in " + where + " — ignored");
      continue;
    }
    const val = obj[key];
    if (typeof spec === "string") {
      if (!TYPE_CHECKS[spec](val)) {
        throw new Error("[agent-shim] config '" + key + "' in " + where + " must be " + spec + ", got " + typeof val);
      }
    } else {
      if (!isPlainObject(val)) {
        throw new Error("[agent-shim] config '" + key + "' in " + where + " must be an object, got " + typeof val);
      }
      for (const sub of Object.keys(val)) {
        const t = spec.keys && spec.keys[sub];
        if (!t) {
          logger.warn("unknown config key '" + key + "." + sub + "' in " + where + " — ignored");
          continue;
        }
        if (!TYPE_CHECKS[t](val[sub])) {
          throw new Error("[agent-shim] config '" + key + "." + sub + "' in " + where + " must be " + t + ", got " + typeof val[sub]);
        }
      }
    }
  }
}

// ===== User-config discovery =====
function findUserConfig() {
  const explicit = process.env.AGENT_SHIM_CONFIG || process.env.REMOTE_BRIDGE_CONFIG;
  if (explicit) {
    let data;
    try {
      data = readJson(explicit);
    } catch (e) {
      if (e.code === "ENOENT") {
        const envName = process.env.AGENT_SHIM_CONFIG ? "AGENT_SHIM_CONFIG" : "REMOTE_BRIDGE_CONFIG";
        throw new Error(
          "[agent-shim] " + envName + " is set to " + JSON.stringify(explicit) +
            " but no file exists at that path.\n" +
            "Create it, or unset the env var to auto-discover .agent-shim.json.\n" +
            "A template lives at .agent-shim.example.json."
        );
      }
      throw new Error("[agent-shim] Failed to parse config " + JSON.stringify(explicit) + ": " + e.message);
    }
    return { path: explicit, data, deprecated: !process.env.AGENT_SHIM_CONFIG };
  }
  const candidates = [
    { path: path.join(process.cwd(), ".agent-shim.json"), deprecated: false },
    { path: path.join(LAUNCHER_DIR, ".agent-shim.json"), deprecated: false },
    { path: path.join(os.homedir(), ".config", "agent-shim", "config.json"), deprecated: false },
    { path: path.join(process.cwd(), ".remote-bridge.json"), deprecated: true },
    { path: path.join(LAUNCHER_DIR, ".remote-bridge.json"), deprecated: true },
  ];
  for (const c of candidates) {
    try {
      return { path: c.path, data: readJson(c.path), deprecated: c.deprecated };
    } catch (e) {
      // not present — try next
    }
  }
  return null;
}

function envInt(name, def) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

// env var > file key > undefined (caller validates if required).
function pick(envName, fileKey, fileObj) {
  const ev = process.env[envName];
  if (ev !== undefined && ev !== "") return ev;
  if (fileObj && fileObj[fileKey] !== undefined) return fileObj[fileKey];
  return undefined;
}

function required(value, label, where) {
  if (value === undefined || value === null || value === "") {
    throw new Error(
      '[agent-shim] Required setting "' + label + '" is missing.\n' +
        "Set " + where + ", or add it to your config file.\n" +
        "See .agent-shim.example.json for a template."
    );
  }
  return value;
}

// Lightweight early read of the `byok` flag for the BYOK ESM hook registration in index.js,
// which runs BEFORE full config load() (and before the remote-control bail). Unlike load(),
// this never throws and doesn't require host/user/vcwd — it only discovers the user config
// file and reads the bool. Returns false on missing file / missing field / any error, so the
// remote-control path (which may have no valid remote config) isn't broken by a forced throw.
function loadByokFlag() {
  try {
    const info = findUserConfig();
    if (!info) return false;
    const v = info.data.byok;
    return v === true || v === "true";
  } catch (_) {
    return false;
  }
}

function load() {
  let defaults = {};
  try {
    defaults = readJson(DEFAULT_CONFIG_PATH);
  } catch (e) {
    throw new Error(
      "[agent-shim] Default config file not found at " + JSON.stringify(DEFAULT_CONFIG_PATH) +
        ".\nThis file ships with the launcher and should not be deleted."
    );
  }

  const info = findUserConfig();
  const userConfig = info ? info.data : {};
  if (info) {
    validate(userConfig, info.path);
    if (info.deprecated) {
      logger.warn(
        "config loaded from " + info.path + " — .remote-bridge.json / REMOTE_BRIDGE_CONFIG is deprecated; " +
          "rename to .agent-shim.json (or set AGENT_SHIM_CONFIG)"
      );
    }
  }

  const file = mergeConfig(defaults, userConfig);
  const fileSSH = file.ssh || {};
  const fileHTTP = file.http || {};
  const filePaths = file.paths || {};
  const fileEnv = file.env || {};

  const transport = pick("AGENT_SHIM_TRANSPORT", "transport", file) || "ssh";

  let host, user, port, keyPath, token, tls;
  if (transport === "http") {
    host = required(
      pick("REMOTE_OPS_HOST", "host", fileHTTP),
      "http.host",
      "REMOTE_OPS_HOST env var or http.host"
    );
    token = required(
      pick("REMOTE_OPS_TOKEN", "token", fileHTTP),
      "http.token",
      "REMOTE_OPS_TOKEN env var or http.token"
    );
    port = envInt("REMOTE_OPS_PORT", fileHTTP.port) || 8765;
    tls = pick("REMOTE_OPS_TLS", "tls", fileHTTP) === true || pick("REMOTE_OPS_TLS", "tls", fileHTTP) === "true";
    user = "";
    keyPath = "";
  } else {
    host = required(
      pick("REMOTE_BRIDGE_HOST", "host", fileSSH),
      "host",
      "REMOTE_BRIDGE_HOST env var or ssh.host"
    );
    user = required(
      pick("REMOTE_BRIDGE_USER", "user", fileSSH),
      "user",
      "REMOTE_BRIDGE_USER env var or ssh.user"
    );
    port = envInt("REMOTE_BRIDGE_PORT", fileSSH.port);
    keyPath = expandHome(pick("REMOTE_BRIDGE_KEY", "keyPath", fileSSH));
    token = "";
    tls = false;
  }

  // Project-internal default for the ssh2 module location (not remote config).
  const ssh2PathDefault = path.join(LAUNCHER_DIR, "node_modules", "ssh2");
  let ssh2Path = pick("REMOTE_BRIDGE_SSH2", "ssh2", filePaths) || ssh2PathDefault;
  if (!path.isAbsolute(ssh2Path)) {
    ssh2Path = path.resolve(LAUNCHER_DIR, ssh2Path);
  }

  const keepaliveInterval = envInt("REMOTE_BRIDGE_KEEPALIVE", file.keepalive);
  const readyTimeout = envInt("REMOTE_BRIDGE_READY_TIMEOUT", file.readyTimeout);

  // Telemetry suppression (default true). false = allow the agent's OTLP exporter to
  // reach its collector. Accepts the config bool, the REMOTE_BRIDGE_DISABLE_TELEMETRY
  // env var, or "true"/"false" strings.
  const _dtRaw = pick("REMOTE_BRIDGE_DISABLE_TELEMETRY", "disableTelemetry", file);
  const disableTelemetry = _dtRaw === undefined || _dtRaw === null || _dtRaw === "" ? true : !/^(false|0|no|off)$/i.test(String(_dtRaw));

  const vcwd = required(
    pick("REMOTE_BRIDGE_VCWD", "vcwd", filePaths),
    "vcwd",
    "REMOTE_BRIDGE_VCWD env var or paths.vcwd"
  );

  // Optional fake os.release() return value. qoder's system prompt embeds `OS Version:
  // ${os.release()}`, which on Windows yields "10.0.19044" — leaking a Windows build
  // number into a prompt that otherwise claims platform=linux. Setting this to a
  // Linux-style kernel version (e.g. "6.5.0-14-generic") makes the prompt
  // self-consistent. Empty = leave real os.release() alone (Phase 6 may probe uname -r).
  // Never queries the remote.
  const osRelease = pick("REMOTE_BRIDGE_OS_RELEASE", "osRelease", filePaths) || "";

  // Optional explicit remote Node version. qoder's system prompt renders
  // `Node.js version: ${process.version}`, which leaks the host's Windows Node version.
  // Set this (e.g. "v20.19.2") to force a value and skip the `node --version` probe.
  // Empty = probe the remote (or leave the host version if the probe fails / no remote node).
  const nodeVersion = pick("REMOTE_BRIDGE_NODE_VERSION", "nodeVersion", filePaths) || "";

  // Optional explicit remote CPU arch. qoder's system prompt renders
  // `Architecture: ${process.arch}` and its native-binary selector uses arch. Set this
  // (e.g. "arm64") to force a value and skip the `uname -m` probe. Empty = probe the remote.
  const arch = pick("REMOTE_BRIDGE_ARCH", "arch", filePaths) || "";

  // Optional explicit remote HOME. The ambient Windows process.env.HOME is a
  // drive-qualified local path that would misroute ~-relative paths, so the bridge
  // probes the remote HOME by default. Set this to force a value and skip the probe.
  const home = pick("REMOTE_BRIDGE_HOME", "home", filePaths) || "";

  // Optional SOCKS5 proxy for the SSH connection (e.g. wstunnel QUIC tunnel).
  // Empty = direct connection.
  const socksProxy = pick("REMOTE_BRIDGE_SOCKS_PROXY", "socksProxy", filePaths) || "";

  // localBash: explicit config/env override only. Auto-detection (probing agent-specific
  // paths + PATH scan) is handled by the adapter's getLocalBash().
  const localBash = pick("REMOTE_BRIDGE_LOCAL_BASH", "localBash", filePaths) || "";

  // Extra env vars from config file. Applied by platform.js, not here.
  const extraEnv = fileEnv;

  // Per-connection probe cache. cachePath is a DIRECTORY; the cache file is hashed from
  // host:user:port so two servers (or two users on the same host) never share a cache.
  let cacheDir = pick("REMOTE_BRIDGE_CACHE_PATH", "cachePath", filePaths) || "";
  if (!cacheDir) cacheDir = LAUNCHER_DIR;
  else if (!path.isAbsolute(cacheDir)) cacheDir = path.resolve(LAUNCHER_DIR, cacheDir);
  const cacheId = host + ":" + user + ":" + (port || 22);
  const cacheHash = crypto.createHash("sha256").update(cacheId).digest("hex").slice(0, 12);
  const cacheFile = path.join(cacheDir, ".agent-shim-cache-" + cacheHash + ".json");

  // Virtual workspace id: the /◦<id>/ prefix the agent sees on its cwd, so qoder's
  // session-key hash (CB, non-normalizing) buckets each connection distinctly even when two
  // remotes expose the same vcwd (e.g. /root). Uses host∶port (∶ = U+2236 ratio, not the
  // Windows-forbidden colon U+003A) so the id is human-readable in pwd/TUI output.
  // cacheHash (hex) is kept for local cache/profile filenames.
  const boxId = host + "\u2236" + (port || 22);

  // Legacy per-profile agent data isolation (QODER_CLI_HOME override). Superseded by the
  // virtual workspace prefix, which isolates sessions by cwd-hash without a separate data
  // dir — so .qoder (auth, LLM config, settings) is shared natively across connections.
  // Kept as an opt-in escape hatch: isolateData="profile" selects the old behavior.
  const isolateData = pick("REMOTE_SHIM_ISOLATE_DATA", "isolateData", filePaths);
  const _doProfileIsolate = isolateData === "profile";
  let dataDir = pick("REMOTE_SHIM_DATA_DIR", "dataDir", filePaths) || "";
  if (!dataDir) dataDir = cacheDir;
  else if (!path.isAbsolute(dataDir)) dataDir = path.resolve(LAUNCHER_DIR, dataDir);
  const cliHomeExplicit = pick("REMOTE_SHIM_CLI_HOME", "cliHome", filePaths) || "";
  // vcwd slug mirrors qoder's own project-dir naming (/ and \ → -), so a human can map a
  // profile dir back to the remote cwd it represents.
  const vcwdSlug = String(vcwd).replace(/[\\/]+/g, "-").replace(/^-+|-+$/g, "") || "root";
  const profileDir = path.join(dataDir, "profiles", cacheHash + "-" + vcwdSlug);

  return Object.freeze({
    transport, host, user, port, keyPath, token, tls, ssh2Path, keepaliveInterval, readyTimeout,
    vcwd, osRelease, home, localBash, extraEnv, cacheDir, cacheFile, socksProxy,
    boxId, isolateData: _doProfileIsolate, dataDir, cliHomeExplicit, profileDir, nodeVersion, arch, disableTelemetry,
    byok: file.byok === true || file.byok === "true",
  });
}

module.exports = { load, loadByokFlag, expandHome, validate, mergeConfig };
