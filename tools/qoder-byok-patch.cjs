// qoder-byok-patch.cjs — invasive bundle patcher for qodercli 1.1.64
// Adapted from the 1.1.43 py patcher. Forces BYOK custom-provider activation in
// remote-control mode so BYOK models appear in the web/mobile model list.
//
// Patches (1.1.64):
//   P1  canUseCustomProviders(){return!0}            — bypass the access-state gate
//   P5  wA: drop remoteWorker+TE() → "disabled"      — keep BYOK providers in RC worker
//   P4  setModel: bare official name → this.model    — pin RC selection to BYOK route
//   P6  init: force !isServiceAccount (l=0)          — run initializeCustomProviders + BYOK load
//
// P5 is the critical one: TE() = !!process.env.QODER_REMOTE_WORKER is true in the RC worker
// subprocess, so any TE()?"disabled" branch wipes customProviderSettings there → BYOK models
// never enter the registry → FatalRoutingError. Dropping both remoteWorker and TE() conditions
// forces wA="local" in the worker, preserving providers end-to-end.
//
// Usage: node qoder-byok-patch.cjs [--check|--restore|--apply] [bundle.js]
// Default bundle: the live qodercli.js in the npm install.
// Idempotent: detects already-patched state via signatures and skips.

const fs = require("fs");
const path = require("path");
const os = require("os");

const ID = "[A-Za-z_$][\\w$]*";

function defaultBundle() {
  const base = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@qoder-ai", "qodercli", "bundle", "qodercli.js");
  return fs.existsSync(base) ? base : null;
}

const PATCHES = [
  {
    name: "P1 canUseCustomProviders forced true",
    needle: 'canUseCustomProviders(){return"allowed"===this.customProviderAccess.state}',
    repl: 'canUseCustomProviders(){return!0}',
    sig: 'canUseCustomProviders(){return!0}',
    required: true,
  },
  {
    name: "P5 wA: drop remoteWorker+TE() disabled branch (keep providers in RC worker)",
    // Original: wA="remoteWorker"===i.startupMode||TE()?"disabled":"sdk"===i.startupMode?"sdk":"local"
    // TE() = !!process.env.QODER_REMOTE_WORKER, which is TRUE in the RC worker subprocess.
    // So even after dropping the remoteWorker branch, the worker still got wA="disabled" ->
    // customProviderSettings:void 0 -> BYOK models wiped from the registry -> FatalRoutingError.
    // Drop BOTH the remoteWorker and TE() conditions so wA="local" in the worker too. Keep the
    // sdk branch for non-RC sdk startup. needles[0]=pristine, [1]=old-P5-patched form (idempotent).
    needles: [
      'wA="remoteWorker"===i.startupMode||TE()?"disabled":"sdk"===i.startupMode?"sdk":"local"',
      'wA=TE()?"disabled":"sdk"===i.startupMode?"sdk":"local"',
    ],
    repl: 'wA="sdk"===i.startupMode?"sdk":"local"',
    sig: 'wA="sdk"===i.startupMode?"sdk":"local"',
    required: true,
  },
  {
    name: "P4 setModel: bare official name → this.model redirect",
    // match setModel(A,e=!0){...} and inject the redirect guard at the top of the body
    needle: 'setModel(A,e=!0){(this.model!==A||this._activeModel!==A)',
    repl: 'setModel(A,e=!0){if(typeof A==="string"&&A&&A.indexOf("/")<0&&this.model&&this.model.indexOf("/")>0)A=this.model;(this.model!==A||this._activeModel!==A)',
    sig: 'if(typeof A==="string"&&A&&A.indexOf("/")<0&&this.model&&this.model.indexOf("/")>0)A=this.model',
    required: false,
  },
  {
    name: "P6 init: force initializeCustomProviders over service-account deactivate",
    // In remote-control the worker init (x9) computes l=n.isServiceAccount() and then:
    //   l?deactivateCustomProviders("service_account"):await initializeCustomProviders()
    //   A.loadByok&&!l&&...  (BYOK load only when !l)
    // A qoder login that resolves to a service-account principal sets l=true, taking the
    // deactivate branch — BYOK never activates, custom models never enter the registry the
    // web sees. Force l=false so init runs AND BYOK load runs. Localized to x9's assignment.
    needle: 'let l=n.isServiceAccount();',
    repl: 'let l=0;',
    sig: 'let l=0;!Jd()',
    required: true,
  },
];

function readBundle(p) { return fs.readFileSync(p, "utf8"); }

function applyPatches(src) {
  let out = src;
  const report = [];
  for (const p of PATCHES) {
    if (src.includes(p.sig)) { report.push({ name: p.name, status: "already-patched" }); continue; }
    const needles = Array.isArray(p.needles) ? p.needles : [p.needle];
    let matched = -1, ambiguous = false;
    for (let k = 0; k < needles.length; k++) {
      const count = src.split(needles[k]).length - 1;
      if (count === 1) { matched = k; break; }
      if (count > 1) { ambiguous = true; report.push({ name: p.name, status: "AMBIGUOUS (" + count + " matches, form " + k + ")" }); break; }
    }
    if (ambiguous) continue;
    if (matched === -1) { report.push({ name: p.name, status: p.required ? "MISSING (needle not found)" : "n/a (needle absent)" }); continue; }
    out = out.replace(needles[matched], p.repl);
    report.push({ name: p.name, status: "patched" });
  }
  return { out, report };
}

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
