// lib/path-bridge.js
// Patches the `path` module so that REMOTE paths (posix-absolute, no drive) use posix
// semantics, while LOCAL paths (drive-qualified) keep win32 semantics.
//
// Root cause: on Windows, `path.resolve("/root/foo")` returns `\root\foo` (backslashes,
// no drive). This breaks the Edit tool (path mismatch → "0 occurrences found"), the TUI
// startup-dir display (shows `\root`), and security hooks (try to read `\root\...` locally).
// With this patch, `path.resolve("/root/foo")` returns `/root/foo` (posix), while
// `path.resolve("C:\\Users\\foo")` still returns `C:\Users\foo` (win32).
//
// Rule: if NO argument has a drive letter (X:), the result is a posix path → use path.posix.
//      if ANY argument has a drive letter, the result is a Windows path → use path.win32.

const path = require("path");

function anyHasDrive(args) {
  return args.some((a) => {
    const s = String(a).replace(/\\/g, "/");
    return /^[a-zA-Z]:/.test(s);
  });
}

// Capture originals (on win32, path.* === path.win32.*).
const orig = {
  resolve: path.resolve,
  join: path.join,
  normalize: path.normalize,
  dirname: path.dirname,
  basename: path.basename,
  extname: path.extname,
  relative: path.relative,
  isAbsolute: path.isAbsolute,
  parse: path.parse,
  format: path.format,
  toNamespacedPath: path.toNamespacedPath,
};

// path.resolve: use posix when no arg has a drive (result will be posix-absolute or relative
// to a posix cwd). path.posix.resolve uses process.cwd() internally, which returns /root.
path.resolve = function (...args) {
  if (anyHasDrive(args)) return orig.resolve.apply(path, args);
  return path.posix.resolve(...args);
};

// path.join: same rule.
path.join = function (...args) {
  if (anyHasDrive(args)) return orig.join.apply(path, args);
  return path.posix.join(...args);
};

// path.normalize: single input.
path.normalize = function (p) {
  if (anyHasDrive([p])) return orig.normalize.call(path, p);
  return path.posix.normalize(p);
};

// path.dirname: single input.
path.dirname = function (p) {
  if (anyHasDrive([p])) return orig.dirname.call(path, p);
  return path.posix.dirname(p);
};

// path.basename: path + optional ext.
path.basename = function (p, ext) {
  if (anyHasDrive([p])) return orig.basename.call(path, p, ext);
  return ext !== undefined ? path.posix.basename(p, ext) : path.posix.basename(p);
};

// path.extname: single input.
path.extname = function (p) {
  if (anyHasDrive([p])) return orig.extname.call(path, p);
  return path.posix.extname(p);
};

// path.relative: two inputs, both must be same namespace.
path.relative = function (from, to) {
  if (anyHasDrive([from, to])) return orig.relative.call(path, from, to);
  return path.posix.relative(from, to);
};

// path.isAbsolute: posix.isAbsolute returns true for /root (correct for remote);
// for drive-qualified paths, use win32.
path.isAbsolute = function (p) {
  if (anyHasDrive([p])) return orig.isAbsolute.call(path, p);
  return path.posix.isAbsolute(p);
};

// path.parse: single input.
path.parse = function (p) {
  if (anyHasDrive([p])) return orig.parse.call(path, p);
  return path.posix.parse(p);
};

// path.format: use posix if root has no drive.
path.format = function (obj) {
  const root = String((obj && obj.root) || "");
  const dir = String((obj && obj.dir) || "");
  if (anyHasDrive([root, dir])) return orig.format.call(path, obj);
  return path.posix.format(obj);
};

// path.toNamespacedPath: for remote paths, return as-is (no namespace conversion).
path.toNamespacedPath = function (p) {
  if (anyHasDrive([p])) return orig.toNamespacedPath.call(path, p);
  return String(p);
};

module.exports = { apply: () => {}, orig };
