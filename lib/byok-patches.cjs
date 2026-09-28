// Shared BYOK patch definitions for qodercli 1.1.64.
// Consumed by tools/qoder-byok-patch.cjs (invasive file patcher) and lib/byok-hook.mjs
// (non-invasive ESM load hook). Keep both in sync via this single source.
//
// Patches:
//   P1  canUseCustomProviders(){return!0}         — bypass the access-state gate
//   P5  wA: drop remoteWorker+TE() -> "disabled"  — keep BYOK providers in RC worker
//   P4  setModel: bare official name -> this.model — pin RC selection to BYOK route
//   P6  init: force !isServiceAccount (l=0)       — run initializeCustomProviders + BYOK load
//
// P5 is the critical one: TE() = !!process.env.QODER_REMOTE_WORKER is true in the RC worker
// subprocess, so any TE()?"disabled" branch wipes customProviderSettings there -> BYOK models
// never enter the registry -> FatalRoutingError. Dropping both remoteWorker and TE() conditions
// forces wA="local" in the worker, preserving providers end-to-end.

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
    needles: [
      'wA="remoteWorker"===i.startupMode||TE()?"disabled":"sdk"===i.startupMode?"sdk":"local"',
      'wA=TE()?"disabled":"sdk"===i.startupMode?"sdk":"local"',
    ],
    repl: 'wA="sdk"===i.startupMode?"sdk":"local"',
    sig: 'wA="sdk"===i.startupMode?"sdk":"local"',
    required: true,
  },
  {
    name: "P4 setModel: bare official name -> this.model redirect",
    needle: 'setModel(A,e=!0){(this.model!==A||this._activeModel!==A)',
    repl: 'setModel(A,e=!0){if(typeof A==="string"&&A&&A.indexOf("/")<0&&this.model&&this.model.indexOf("/")>0)A=this.model;(this.model!==A||this._activeModel!==A)',
    sig: 'if(typeof A==="string"&&A&&A.indexOf("/")<0&&this.model&&this.model.indexOf("/")>0)A=this.model',
    required: false,
  },
  {
    name: "P6 init: force initializeCustomProviders over service-account deactivate",
    needle: 'let l=n.isServiceAccount();',
    repl: 'let l=0;',
    sig: 'let l=0;!Jd()',
    required: true,
  },
];

// Apply all patches to source. Returns { out, report }. Idempotent: a patch whose sig is
// already present is skipped as "already-patched". needles (array) lets a patch match either
// the pristine form or a prior-patched form, so re-running on a partially-patched bundle is safe.
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

module.exports = { PATCHES, applyPatches };
