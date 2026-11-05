const qoder = require("./qoder");
const pi = require("./pi");
const nullAdapter = require("./null");

function select(mainScript, cfg) {
  let role = qoder.detectRole(mainScript);
  let adapter;
  if (role !== "unknown") adapter = qoder.create(cfg);
  else {
    role = pi.detectRole(mainScript);
    if (role !== "unknown") adapter = pi.create(cfg);
    else {
      role = nullAdapter.detectRole(mainScript);
      adapter = nullAdapter.create(cfg);
    }
  }
  // Config-driven local-exec whitelist (exec.localPatterns): commands containing
  // any pattern route to the local bash regardless of adapter. Wraps the adapter's
  // own isHostInternalCmd so all three call sites in routing.js pick it up.
  const patterns = (cfg && cfg.localExecPatterns) || [];
  if (patterns.length) {
    const orig = adapter.isHostInternalCmd;
    adapter.isHostInternalCmd = function (cmd) {
      if (orig && orig(cmd)) return true;
      const s = String(cmd || "");
      return patterns.some((p) => s.includes(p));
    };
  }
  return { role, adapter };
}

module.exports = { select };
