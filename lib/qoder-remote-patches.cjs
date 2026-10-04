// qoder bundle patches — remote-only (apply only when connected to a remote server).
// These strip the virtual workspace prefix /◦host∶port/ from user-visible strings.
// Consumed by lib/qoder-hook.mjs alongside qoder-patches.cjs.
//
// Patches:
//   P7  Primary working directory: strip vCwd prefix   — hide /◦host∶port/ in system prompt
//   P9  Read/Edit "File does not exist" error: strip   — hide /◦host∶port/ in error cwd note
//   P10 Git metadata probe timeout 2s → 15s            — remote fs (HTTPS) needs >2s for the
//        ~7 sequential stat/realpath/read round-trips in uu(); kci=2e3 assumes local fs.
//   P11 EnterWorktree "Cannot create a worktree" error: strip — hide /◦host∶port/ in error path
//
// P7/P9/P11 use the same .replace() that drops /◦host∶port/ (◦ U+25E6, ∶ U+2236, mirroring
// classifier.js WORKSPACE_PREFIX_RE). The prefix MUST stay in process.cwd()/path.resolve(cwd)
// because qoder's session-key hash (CB, non-normalizing) buckets by the exact prefixed string
// for per-connection isolation — so the strip is localized to these display splices only.
//
// P10: qoder's git detector (uu) is pure fs — it stats .git, reads HEAD, stats objects/refs
// via fs.promises.lstat/readFile. Over HTTPS each call is a separate round-trip (~250ms to a
// remote server), and the ~7 sequential calls exceed kci=2e3 (the GitMetadataProbeTimeoutError
// threshold). On timeout uu returns null → "is not inside a Git repository". SSH mode avoids
// this because fs.promises.lstat delegates to lstatSync over a multiplexed SFTP channel. 15s
// gives headroom for slow links; a longer timeout only delays the (rare) genuine non-repo case.

const { ID } = require("./qoder-patches.cjs");

const PATCHES = [
  {
    name: "P7 strip workspace prefix from prompt",
    anchor: "Primary working directory: ",
    needle: new RegExp("Primary working directory: \\$\\{(?<v>" + ID + ")\\}"),
    repl: 'Primary working directory: ${$<v>.replace(/\\/\\u25E6[a-zA-Z0-9.\\-:]+\\u2236\\d+\\//,"/")}',
    sig: /Primary working directory: \$\{[A-Za-z_$][\w$]*\.replace\(\/\\\/\\u25E6/,
    sigAnchor: "Primary working directory: ${",
    required: false,
  },
  {
    name: "P9 strip workspace prefix from error messages",
    anchor: "File does not exist. ",
    needle: new RegExp("File does not exist\\. \\$\\{(?<u>" + ID + ")\\} \\$\\{this\\.config\\.getTargetDir\\(\\)\\}\\."),
    repl: 'File does not exist. ${$<u>} ${this.config.getTargetDir().replace(/\\/\\u25E6[a-zA-Z0-9.\\-:]+\\u2236\\d+\\//,"/")}.',
    sig: /File does not exist\. \$\{[A-Za-z_$][\w$]*\} \$\{this\.config\.getTargetDir\(\)\.replace\(\/\\\/\\u25E6/,
    sigAnchor: "File does not exist. ${",
    required: false,
    multi: true,
  },
  {
    name: "P10 extend git metadata probe timeout for remote fs",
    anchor: '["GIT_DIR","GIT_WORK_TREE"',
    needle: new RegExp("(?<id>" + ID + ")=(?<val>2e3|2000),(?<kuc>" + ID + ")=\\[\"GIT_DIR\",\"GIT_WORK_TREE\""),
    repl: '$<id>=15e3,$<kuc>=["GIT_DIR","GIT_WORK_TREE"',
    sig: /=15e3,[A-Za-z_$][\w$]*=\["GIT_DIR","GIT_WORK_TREE"/,
    sigAnchor: '["GIT_DIR","GIT_WORK_TREE"',
    required: false,
  },
  {
    name: "P11 strip workspace prefix from worktree error",
    anchor: 'Cannot create a worktree: "',
    needle: new RegExp('Cannot create a worktree: "\\$\\{(?<a>' + ID + ')\\}'),
    repl: 'Cannot create a worktree: "${$<a>.replace(/\\/\\u25E6[a-zA-Z0-9.\\-:]+\\u2236\\d+\\//,"/")}',
    sig: /Cannot create a worktree: "\$\{[A-Za-z_$][\w$]*\.replace\(\/\\\/\\u25E6/,
    sigAnchor: 'Cannot create a worktree: "',
    required: false,
  },
];

module.exports = { PATCHES };
