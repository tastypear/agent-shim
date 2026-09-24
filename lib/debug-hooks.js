// lib/debug-hooks.js
// Process-exit survival check. Verifies the fs/spawn patches are still in place when
// the process exits and that fs.writeFileSync still routes remote. Active at
// LOG_LEVEL=debug/trace only. Deliberately uses the PATCHED fs (require("fs").writeSync
// to fd 2) so a broken patch surfaces in the exit output rather than being masked.

const fs = require("fs");
const _log = require("./logger");

function installExitCheck(getVcwd, adapter) {
  if (!_log.isDebug()) return;
  const exitCheckPath = adapter && adapter.getExitCheckPath ? adapter.getExitCheckPath() : null;
  process.on("exit", () => {
    const w = (s) => { try { require("fs").writeSync(2, s + "\n"); } catch (e) {} };
    try {
      const Pf = global.__REMOTE_PROMISES__;
      const promOk = Pf && fs.promises && fs.promises.writeFile === Pf.writeFile;
      w("[EXIT-CHECK] P=" + !!Pf + " promOk=" + promOk);
      w("[EXIT-CHECK] process.cwd()=" + process.cwd() + " vCwd=" + (getVcwd ? getVcwd() : "?"));
      const cc = global.__pCallCounts || {};
      w("[EXIT-CHECK] P-callCounts: writeFile=" + (cc.writeFile || 0) + " stat=" + (cc.stat || 0) + " readFile=" + (cc.readFile || 0));
      if (exitCheckPath) {
        try {
          fs.writeFileSync(exitCheckPath, "EXIT_OK\n");
          w("[EXIT-CHECK] writeFileSync " + exitCheckPath + " OK");
        } catch (e) {
          w("[EXIT-CHECK] writeFileSync " + exitCheckPath + " threw: " + e.code);
        }
      }
    } catch (e) {}
  });
}

function install(getVcwd, adapter) {
  installExitCheck(getVcwd, adapter);
}

module.exports = { install };
