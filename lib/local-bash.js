const fs = require("fs");
const path = require("path");

function findInPath() {
  const isWslBash = (p) => {
    const n = String(p).replace(/\\/g, "/").toLowerCase();
    return n === "c:/windows/system32/bash.exe" || n.endsWith("/system32/bash.exe") || n.endsWith("/system32/bash");
  };
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const cand of [path.join(dir, "bash.exe"), path.join(dir, "bash")]) {
      try {
        if (fs.statSync(cand).isFile() && !isWslBash(cand)) return cand;
      } catch (e) {}
    }
  }
  return "";
}

function find(candidates) {
  for (const cand of candidates) {
    try {
      if (fs.statSync(cand).isFile()) return cand;
    } catch (e) {}
  }
  return findInPath();
}

module.exports = { find, findInPath };
