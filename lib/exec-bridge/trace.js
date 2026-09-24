const fs = require("fs");
const path = require("path");

const _tracePath = path.join(__dirname, "..", "..", "spawn-trace.log");
let _tfd = -1;
try { _tfd = fs.openSync(_tracePath, "a"); } catch (e) {}

function trace(s) {
  if (_tfd < 0) return;
  try { fs.writeSync(_tfd, Date.now() + " " + s + "\n"); } catch (e) {}
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

module.exports = { trace, stdioDesc };
