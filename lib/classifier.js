// lib/classifier.js
// Path classifier (drive-based, no /remote prefix).
//
// Agent-visible namespace: /root, /home, /usr, /etc, ... — all posix-absolute, drive-LESS.
// Host namespace: C:\..., D:\... — drive-qualified Windows paths, AND their MSYS/git-bash
//   posix form /c/..., /d/... (single drive letter after a leading slash). The MSYS form is
//   produced by local bash pwd/echo and must stay LOCAL; without this it would be mistaken
//   for a remote posix path and routed to SFTP (the "Shell cwd recovered from /c/.../bundle"
//   symptom). The tradeoff: a remote path that genuinely starts with /<single-letter>/ would
//   misclassify as local — vanishingly rare on real Linux (/c/ is not a standard root).
//
// path.resolve() on win32 NEVER prepends a drive to a drive-less input (confirmed across a
// real qoder run: zero drive-qualified paths ever classify as remote), so a path is remote
// iff it has no drive letter, is not an MSYS drive form, AND is posix-absolute. This also
// fixes a latent bug in the old prefix classifier: C:\remote\foo was drive-stripped to
// /remote/foo and wrongly routed remote; now C:\anything stays local.
//
// Virtual workspace prefix /◦<host∶port>/: the agent sees its cwd as
// /◦<host>∶<port>/<real-vcwd> (◦ = U+25E6, ∶ = U+2236 ratio — not the Windows-forbidden
// colon U+003A) so qoder's session-key hash (CB, which does NOT normalize) yields a distinct
// bucket per connection — even when two remotes both expose /root. The prefix is
// posix-absolute and drive-less, so it classifies REMOTE and routes through SFTP; toRemote
// strips the /◦<host∶port>/ segment to recover the real remote path. path.posix.resolve
// leaves it intact (no . or .. to collapse), and fs.realpathSync (patched) returns it as-is,
// so the agent's identity stays stable across worktree restore. The ◦ marker + ∶ ratio are
// chosen to be Windows-filesystem-safe (unlike : ), shell-inert (not quoted), git-safe, and
// visually unobtrusive (a small bullet before the host:port label).

// /◦<host>∶<port>/ — host is [a-zA-Z0-9.\-:]+ (domain/IPv4/IPv6), port is digits. The trailing
// slash separates the prefix from the real path. Captured so toRemote can strip the variable-length
// host/port portion. Colon is included for IPv6 addresses (e.g. 2001:bc8:...); the ∶ separator
// (U+2236) is distinct from : (U+003A) so there is no ambiguity.
const WORKSPACE_PREFIX_RE = /^\/\u25E6([a-zA-Z0-9.\-:]+)\u2236(\d+)\//;

function isRemote(p) {
  const norm = String(p).replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(norm)) return false;          // C:\... → local
  if (/^\/[a-zA-Z]\//.test(norm)) return false;       // /c/... → local (MSYS drive form)
  return norm.startsWith("/");
}

// Strip the /◦<host∶port>/ virtual-workspace prefix if present, returning the real remote path
// (still posix-absolute). Otherwise normalize slashes and drop a stray leading drive
// (defensive). A virtual path IS remote, so after stripping it stays posix-absolute and
// drive-less — a valid remote path.
function toRemote(p) {
  const norm = String(p).replace(/\\/g, "/");
  const stripped = norm.replace(WORKSPACE_PREFIX_RE, "/");
  if (stripped !== norm) return stripped;             // prefix was present → real path after "/"
  return norm.replace(/^[a-zA-Z]:/, "");
}

// Does this path carry the virtual workspace prefix? (Used to decide cwd routing: a prefixed
// cwd must be stripped before being sent to the remote shell, which has no /◦<host> dir.)
function hasWorkspacePrefix(p) {
  return WORKSPACE_PREFIX_RE.test(String(p).replace(/\\/g, "/"));
}

// Build the virtual cwd the agent sees: /◦<id>/ + real vcwd. id is "host∶port".
function makeVirtualCwd(id, vcwd) {
  const v = String(vcwd).replace(/\\/g, "/");
  const real = v.startsWith("/") ? v : "/" + v;
  return "/\u25E6" + id + real;
}

// Returns true if the path is a posix-absolute, drive-LESS path — i.e. the same as isRemote,
// kept as a separate export for readability at call sites that test host-ness vs remote-ness.
function isLocal(p) {
  return !isRemote(p);
}

module.exports = { isRemote, toRemote, isLocal, hasWorkspacePrefix, makeVirtualCwd };
