// lib/config.js
// Configuration loader. No host-specific/private values are hardcoded here — all
// remote connection settings come from env vars, a user config file, or
// remote-default.json (tracked, generic defaults only).
//
// Resolution priority (highest → lowest):
//   1. REMOTE_BRIDGE_* environment variables
//   2. User config: REMOTE_BRIDGE_CONFIG path, else auto-discovered .remote-bridge.json
//   3. remote-default.json (tracked, generic defaults only)
//
// If REMOTE_BRIDGE_CONFIG points to a missing file, a descriptive error naming the
// exact path is thrown so the user knows what to create/fix. host, user, and vcwd
// are required — if still missing after resolution, a descriptive error names where
// to set them.
//
// All values are resolved at require() time and frozen into a single object.

const fs = require("fs");
const path = require("path");
const os = require("os");

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
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw);
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

function resolveConfig() {
  // Base layer: tracked generic defaults (no private info).
  let defaults = {};
  try {
    defaults = readJson(DEFAULT_CONFIG_PATH);
  } catch (e) {
    throw new Error(
      "[remote-bridge] Default config file not found at " +
        JSON.stringify(DEFAULT_CONFIG_PATH) +
        ".\nThis file ships with the launcher and should not be deleted."
    );
  }

  // User config layer.
  let userConfig = {};
  const explicit = process.env.REMOTE_BRIDGE_CONFIG;
  if (explicit) {
    try {
      userConfig = readJson(explicit);
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error(
          "[remote-bridge] REMOTE_BRIDGE_CONFIG is set to " +
            JSON.stringify(explicit) +
            " but no file exists at that path.\n" +
            "Create it, or unset REMOTE_BRIDGE_CONFIG to auto-discover " +
            ".remote-bridge.json in the cwd or launcher dir.\n" +
            "A template lives at .remote-bridge.example.json."
        );
      }
      throw new Error(
        "[remote-bridge] Failed to parse config " + JSON.stringify(explicit) + ": " + e.message
      );
    }
  } else {
    const candidates = [
      path.join(process.cwd(), ".remote-bridge.json"),
      path.join(LAUNCHER_DIR, ".remote-bridge.json"),
    ];
    for (const c of candidates) {
      try {
        userConfig = readJson(c);
        break;
      } catch (e) {
        // not present — try next candidate
      }
    }
  }

  return mergeConfig(defaults, userConfig);
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
      '[remote-bridge] Required setting "' +
        label +
        '" is missing.\n' +
        "Set " +
        where +
        ", or add it to your config file.\n" +
        "See .remote-bridge.example.json for a template."
    );
  }
  return value;
}

function load() {
  const file = resolveConfig();
  const fileSSH = (file && file.ssh) || {};
  const filePaths = (file && file.paths) || {};
  const fileEnv = (file && file.env) || {};

  const host = required(
    pick("REMOTE_BRIDGE_HOST", "host", fileSSH),
    "host",
    "REMOTE_BRIDGE_HOST env var or ssh.host"
  );
  const user = required(
    pick("REMOTE_BRIDGE_USER", "user", fileSSH),
    "user",
    "REMOTE_BRIDGE_USER env var or ssh.user"
  );
  const port = envInt("REMOTE_BRIDGE_PORT", fileSSH.port);

  const keyPath = expandHome(pick("REMOTE_BRIDGE_KEY", "keyPath", fileSSH));

  // Project-internal default for the ssh2 module location (not remote config).
  const ssh2PathDefault = path.join(LAUNCHER_DIR, "node_modules", "ssh2");
  let ssh2Path = pick("REMOTE_BRIDGE_SSH2", "ssh2", filePaths) || ssh2PathDefault;
  if (!path.isAbsolute(ssh2Path)) {
    ssh2Path = path.resolve(LAUNCHER_DIR, ssh2Path);
  }

  const keepaliveInterval = envInt("REMOTE_BRIDGE_KEEPALIVE", file.keepalive);
  const readyTimeout = envInt("REMOTE_BRIDGE_READY_TIMEOUT", file.readyTimeout);

  const vcwd = required(
    pick("REMOTE_BRIDGE_VCWD", "vcwd", filePaths),
    "vcwd",
    "REMOTE_BRIDGE_VCWD env var or paths.vcwd"
  );

  // Optional fake os.release() return value. qoder's system prompt embeds `OS Version:
  // ${os.release()}`, which on Windows yields "10.0.19044" — leaking a Windows build
  // number into a prompt that otherwise claims platform=linux, which the AI finds
  // contradictory and tries to verify. Setting this to a Linux-style kernel version
  // (e.g. "6.5.0-14-generic") makes the prompt self-consistent. Empty = leave real
  // os.release() alone. Never queries the remote.
  const osRelease = pick("REMOTE_BRIDGE_OS_RELEASE", "osRelease", filePaths) || "";

  // Optional SOCKS5 proxy for the SSH connection (e.g. wstunnel QUIC tunnel).
  // When set, ssh2 connects through the proxy instead of direct TCP. Format:
  // "host:port" or "socks5://host:port". Empty = direct connection.
  const socksProxy = pick("REMOTE_BRIDGE_SOCKS_PROXY", "socksProxy", filePaths) || "";

  // Auto-detect a local bash for qoder-internal helper commands. Explicit override wins.
  // Used by the qoder adapter for host-internal helpers (snapshots/ensure-deps/security
  // hooks) that reference Windows paths and cannot run on the remote.
  //
  // CRITICAL: must be an MSYS/git bash, NOT WSL's C:\Windows\System32\bash.exe. WSL's sh
  // is dash, which can't resolve drive-qualified Windows paths (C:\...) → hook commands
  // like `sh 'C:\...\qodersec-launch.sh'` fail with "sh: 0: cannot open ... No such file".
  // qoder ships its own git bash at ~/.qoder/bin/git/, but that dir is only in PATH when
  // qoder itself injects it — a user launching qoder from a bare PowerShell/WezTerm won't
  // have it. So we can't rely on PATH alone; probe known locations first, then fall back
  // to PATH while explicitly skipping the WSL launcher.
  let localBash = pick("REMOTE_BRIDGE_LOCAL_BASH", "localBash", filePaths) || "";
  if (!localBash) {
    const isWslBash = (p) => {
      const n = String(p).replace(/\\/g, "/").toLowerCase();
      return n === "c:/windows/system32/bash.exe" || n.endsWith("/system32/bash.exe") || n.endsWith("/system32/bash");
    };
    // 1) qoder's bundled git bash (always present when qoder is installed).
    const home = os.homedir();
    const qoderBashCandidates = [
      path.join(home, ".qoder", "bin", "git", "usr", "bin", "bash.exe"),
      path.join(home, ".qoder", "bin", "git", "bin", "bash.exe"),
    ];
    for (const cand of qoderBashCandidates) {
      try {
        if (fs.statSync(cand).isFile()) { localBash = cand; break; }
      } catch (e) {}
    }
    // 2) Fall back to PATH scan, skipping the WSL launcher explicitly.
    if (!localBash) {
      for (const dir of (process.env.PATH || "").split(path.delimiter)) {
        if (!dir) continue;
        for (const cand of [path.join(dir, "bash.exe"), path.join(dir, "bash")]) {
          try {
            if (fs.statSync(cand).isFile() && !isWslBash(cand)) {
              localBash = cand;
              break;
            }
          } catch (e) {}
        }
        if (localBash) break;
      }
    }
  }

  // Extra env vars from config file. Applied by platform.js, not here.
  const extraEnv = fileEnv;

  // Disk cache for environment-probe results (machine-id, /proc/version, container
  // detection, etc). Persisted across restarts so qoder startup doesn't re-probe the
  // remote every launch. Defaults to .remote-bridge-cache.json next to the launcher.
  // Set REMOTE_BRIDGE_REFRESH_CACHE=1 at launch to force re-fetch all probe values.
  let cachePath = pick("REMOTE_BRIDGE_CACHE_PATH", "cachePath", filePaths) || "";
  if (!cachePath) {
    cachePath = path.join(LAUNCHER_DIR, ".remote-bridge-cache.json");
  } else if (!path.isAbsolute(cachePath)) {
    cachePath = path.resolve(LAUNCHER_DIR, cachePath);
  }

  return Object.freeze({
    host,
    user,
    port,
    keyPath,
    ssh2Path,
    keepaliveInterval,
    readyTimeout,
    vcwd,
    osRelease,
    localBash,
    extraEnv,
    cachePath,
    socksProxy,
  });
}

module.exports = { load, expandHome };
