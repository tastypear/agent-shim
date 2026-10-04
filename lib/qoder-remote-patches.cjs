// qoder bundle patches — remote-only (apply only when connected to a remote server).
// These strip the virtual workspace prefix /◦host∶port/ from user-visible strings.
// Consumed by lib/qoder-hook.mjs alongside qoder-patches.cjs.
//
// Patches:
//   P7  Primary working directory: strip vCwd prefix   — hide /◦host∶port/ in system prompt
//   P9  Read/Edit "File does not exist" error: strip   — hide /◦host∶port/ in error cwd note
//
// Both use the same .replace() that drops /◦host∶port/ (◦ U+25E6, ∶ U+2236, mirroring
// classifier.js WORKSPACE_PREFIX_RE). The prefix MUST stay in process.cwd()/path.resolve(cwd)
// because qoder's session-key hash (CB, non-normalizing) buckets by the exact prefixed string
// for per-connection isolation — so the strip is localized to these display splices only.

const { ID } = require("./qoder-patches.cjs");

const PATCHES = [
  {
    name: "P7 prompt: strip vCwd prefix from Primary working directory",
    anchor: "Primary working directory: ",
    needle: new RegExp("Primary working directory: \\$\\{(?<v>" + ID + ")\\}"),
    repl: 'Primary working directory: ${$<v>.replace(/\\/\\u25E6[a-zA-Z0-9.\\-:]+\\u2236\\d+\\//,"/")}',
    sig: /Primary working directory: \$\{[A-Za-z_$][\w$]*\.replace\(\/\\\/\\u25E6/,
    sigAnchor: "Primary working directory: ${",
    required: false,
  },
  {
    name: "P9 Read/Edit error: strip vCwd prefix from getTargetDir() in 'File does not exist' message",
    anchor: "File does not exist. ",
    needle: new RegExp("File does not exist\\. \\$\\{(?<u>" + ID + ")\\} \\$\\{this\\.config\\.getTargetDir\\(\\)\\}\\."),
    repl: 'File does not exist. ${$<u>} ${this.config.getTargetDir().replace(/\\/\\u25E6[a-zA-Z0-9.\\-:]+\\u2236\\d+\\//,"/")}.',
    sig: /File does not exist\. \$\{[A-Za-z_$][\w$]*\} \$\{this\.config\.getTargetDir\(\)\.replace\(\/\\\/\\u25E6/,
    sigAnchor: "File does not exist. ${",
    required: false,
    multi: true,
  },
];

module.exports = { PATCHES };
