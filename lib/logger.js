const _fs = require("fs");

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

function parseLevel(v) {
  if (!v) return LEVELS.info;
  const n = LEVELS[String(v).toLowerCase()];
  return n !== undefined ? n : LEVELS.info;
}

const _level = parseLevel(process.env.LOG_LEVEL);
const _logFile = process.env.LOG_FILE || null;
let _logFd = -1;
if (_logFile) {
  try { _logFd = _fs.openSync(_logFile, "a"); } catch (e) {}
}

function emit(level, mod, msg, fields) {
  const ts = new Date().toISOString();
  if (_logFd >= 0) {
    const obj = { ts, level, mod, msg };
    if (fields) Object.assign(obj, fields);
    try { _fs.writeSync(_logFd, JSON.stringify(obj) + "\n"); } catch (e) {}
  } else {
    let line = "[" + ts + "] [" + level.toUpperCase() + "] [" + mod + "] " + msg;
    if (fields) {
      line += " " + Object.entries(fields).map(([k, v]) =>
        k + "=" + (typeof v === "string" ? v : JSON.stringify(v))
      ).join(" ");
    }
    try { process.stderr.write(line + "\n"); } catch (e) {}
  }
}

function log(level, mod, msg, fields) {
  if (LEVELS[level] > _level) return;
  emit(level, mod, msg, fields);
}

function child(mod) {
  return {
    error: (msg, f) => log("error", mod, msg, f),
    warn: (msg, f) => log("warn", mod, msg, f),
    info: (msg, f) => log("info", mod, msg, f),
    debug: (msg, f) => log("debug", mod, msg, f),
    trace: (msg, f) => log("trace", mod, msg, f),
    traceLazy: (msg, fFn) => {
      if (LEVELS.trace > _level) return;
      emit("trace", mod, msg, typeof fFn === "function" ? fFn() : fFn);
    },
  };
}

function stdioDesc(opts) {
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

function isDebug() { return _level >= LEVELS.debug; }
function isTrace() { return _level >= LEVELS.trace; }

module.exports = { child, log, stdioDesc, isDebug, isTrace, LEVELS };
