// qoder-byok-patch.cjs — invasive bundle patcher for qodercli 1.1.64.
// Applies the shared BYOK patches (lib/byok-patches.cjs) directly to the bundle file on disk.
// For the non-invasive alternative (in-memory via ESM load hook), see lib/byok-hook.mjs.
//
// Usage: node qoder-byok-patch.cjs [--check|--restore|--apply] [bundle.js]
// Default bundle: the live qodercli.js in the npm install.
// Idempotent: detects already-patched state via signatures and skips.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { PATCHES, applyPatches } = require("../lib/byok-patches.cjs");

function defaultBundle() {
  const base = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@qoder-ai", "qodercli", "bundle", "qodercli.js");
  return fs.existsSync(base) ? base : null;
}

function readBundle(p) { return fs.readFileSync(p, "utf8"); }

function main() {
  const argv = process.argv.slice(2);
  let mode = "apply";
  const positional = [];
  for (const a of argv) {
    if (a === "--check") mode = "check";
    else if (a === "--restore") mode = "restore";
    else if (a === "--apply") mode = "apply";
    else positional.push(a);
  }
  const bundle = positional[0] || defaultBundle();
  if (!bundle || !fs.existsSync(bundle)) { console.error("bundle not found"); process.exit(2); }
  const bak = bundle + ".byok.bak";

  if (mode === "restore") {
    if (!fs.existsSync(bak)) { console.error("no backup at " + bak); process.exit(3); }
    fs.copyFileSync(bak, bundle);
    console.log("restored from " + bak);
    return;
  }

  const src = readBundle(bundle);
  const { out, report } = applyPatches(src);

  for (const r of report) console.log(("  " + r.status + " ").padEnd(22) + r.name);

  if (mode === "check") {
    const ok = report.every(r => r.status === "patched" || r.status === "already-patched" || (!PATCHES.find(p => p.name === r.name).required && r.status.startsWith("n/a")));
    console.log(ok ? "\nall required patches present" : "\nMISSING required patches");
    process.exit(ok ? 0 : 1);
  }

  // apply
  const anyAmbiguous = report.some(r => r.status.startsWith("AMBIGUOUS"));
  if (anyAmbiguous) { console.error("aborting: ambiguous match"); process.exit(4); }
  if (!fs.existsSync(bak)) fs.copyFileSync(bundle, bak);
  const tmp = bundle + ".tmp";
  fs.writeFileSync(tmp, out);
  fs.copyFileSync(tmp, bundle);
  try { fs.unlinkSync(tmp); } catch (e) {}
  console.log("\nwritten (backup: " + path.basename(bak) + ")");
}

main();
