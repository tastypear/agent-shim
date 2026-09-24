const qoder = require("./qoder");
const nullAdapter = require("./null");

function select(mainScript, cfg) {
  let role = qoder.detectRole(mainScript);
  if (role !== "unknown") return { role, adapter: qoder.create(cfg) };
  return { role: nullAdapter.detectRole(mainScript), adapter: nullAdapter.create(cfg) };
}

module.exports = { select };
