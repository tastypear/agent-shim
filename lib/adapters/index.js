const qoder = require("./qoder");
const pi = require("./pi");
const nullAdapter = require("./null");

function select(mainScript, cfg) {
  let role = qoder.detectRole(mainScript);
  if (role !== "unknown") return { role, adapter: qoder.create(cfg) };
  role = pi.detectRole(mainScript);
  if (role !== "unknown") return { role, adapter: pi.create(cfg) };
  return { role: nullAdapter.detectRole(mainScript), adapter: nullAdapter.create(cfg) };
}

module.exports = { select };
