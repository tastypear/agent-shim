const { findInPath } = require("../local-bash");

function detectRole() {
  return "unknown";
}

function create(cfg) {
  return {
    name: "none",
    isHostInternalCmd: () => false,
    interceptSpawn: () => null,
    getDefaultEnv: () => ({}),
    getLocalBash: () => cfg.localBash || findInPath(),
    getPrefetchPaths: () => ({ exists: [], stat: [], read: [], readdir: [], access: [] }),
    getSwallowEnoentPatterns: () => [],
    getProbeFiles: () => [],
    getProbeExists: () => [],
    needsOsReleaseFake: () => false,
    getExitCheckPath: () => null,
    getDataDirEnv: () => null,
  };
}

module.exports = { detectRole, create };
