// lib/classifier.js
// Path classifier (drive-based, no /remote prefix).
//
// Agent-visible namespace: /root, /home, /usr, /etc, ... — all posix-absolute, drive-LESS.
// Host namespace: C:\..., D:\... — drive-qualified Windows paths.
//
// path.resolve() on win32 NEVER prepends a drive to a drive-less input (confirmed across a
// real qoder run: zero drive-qualified paths ever classify as remote), so a path is remote
// iff it has no drive letter AND is posix-absolute. This also fixes a latent bug in the old
// prefix classifier: C:\remote\foo was drive-stripped to /remote/foo and wrongly routed
// remote; now C:\anything stays local.

function isRemote(p) {
  const norm = String(p).replace(/\\/g, "/");
  return /^[a-zA-Z]:/.test(norm) === false && norm.startsWith("/");
}

// No prefix to strip: a remote path IS already its remote form. Only normalize slashes and
// drop a stray leading drive (defensive — never produced under the launcher, but keeps
// toRemote a true inverse of isRemote for any input).
function toRemote(p) {
  return String(p).replace(/\\/g, "/").replace(/^[a-zA-Z]:/, "");
}

// Returns true if the path is a posix-absolute, drive-LESS path — i.e. the same as isRemote,
// kept as a separate export for readability at call sites that test host-ness vs remote-ness.
function isLocal(p) {
  return !isRemote(p);
}

module.exports = { isRemote, toRemote, isLocal };
