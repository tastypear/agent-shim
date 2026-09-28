// Shared BYOK patch definitions for qodercli 1.1.64.
// Consumed by tools/qoder-byok-patch.cjs (invasive file patcher) and lib/byok-hook.mjs
// (non-invasive ESM load hook). Keep both in sync via this single source.
//
// ANCHORING POLICY (mirrors the 1.1.43 py patcher):
//   STABLE anchors (method/property names, string literals): canUseCustomProviders,
//     customProviderSettings, .providers, "disabled", void 0, setModel, this.model,
//     this._activeModel, isServiceAccount, initializeCustomProviders, "service_account".
//   UNSTABLE (never anchored): local vars, params, module-level fn names — matched via the
//     ID wildcard [A-Za-z_$][\w$]* as NAMED capture groups, backfilled via $<name>.
//   Named groups + \k<name> backrefs (not \1 digit refs) for clarity and to avoid octal-style
//   ambiguity in JS RegExp.
//
// Patches:
//   P1  canUseCustomProviders(){return!0}              — bypass the access-state gate
//   P5  customProviderSettings: always VAR.providers   — providers never wiped (RC worker)
//   P4  setModel: bare official name -> this.model     — pin RC selection to BYOK route
//   P6  let l=0 (force !isServiceAccount)              — init + BYOK load + activate run
//
// P5 anchors the wA ASSIGNMENT (the mode ternary), not a downstream consumer. wA feeds two
// consumers: customProviderSettings (providers list) AND customModelOverride (the inference
// route override, which needs a real mode VALUE — "local"/"sdk" — not just truthiness). The
// 1.1.43 py patcher anchored the customProviderSettings consumer, but that only fixes the
// providers list; in 1.1.64 wA also drives customModelOverride, so the consumer-only approach
// leaves customModelOverride="disabled" -> inference returns empty. Anchoring wA itself and
// dropping the "remoteWorker"=== + TE() conditions forces wA="local" in the RC worker (where
// TE() = !!process.env.QODER_REMOTE_WORKER is TRUE), fixing both consumers at once.
// Stable anchors: string literals "remoteWorker"/"disabled"/"sdk"/"local" + .startupMode.
//
// Version pins (minified names observed in 1.1.64, for future drift diagnosis):
//   P5 condition var: wA  (wA="remoteWorker"===i.startupMode||TE()?"disabled":"sdk"===i.startupMode?"sdk":"local")
//                     TE() = !!process.env.QODER_REMOTE_WORKER — TRUE in RC worker subprocess
//   P5 providers var: A
//   P6 <l> (isServiceAccount result): l    <n> (auth facade): n
//   P6 follow-site signature anchor: !Jd()&&!l   (Jd = auth-ready gate)
//   P4 setModel params: (A, e=!0)

const ID = "[A-Za-z_$][\\w$]*";

// Performance: regexes with backrefs/ID wildcards catastrophic-backtrack on the 33MB bundle
// if run over the full source. Each patch has an `anchor` — a literal stable substring — used
// to indexOf-locate the site, then the needle regex runs only over a small window around it.
// This keeps O(n) total (indexOf is linear, window regex is ~constant) while preserving the
// semantic-wildcard matching (no minified names hardcoded).
const WIN = 220; // chars of context each side of the anchor — enough for every needle below

const PATCHES = [
  {
    name: "P1 canUseCustomProviders forced true",
    // Stable anchor: method name canUseCustomProviders. Body is any boolean expr (the
    // access-state comparison rotates: "allowed"===X.state in 1.1.64). [^{}]* consumes it.
    anchor: "canUseCustomProviders(){return",
    needle: /canUseCustomProviders\(\)\{return[^{}]*\}/,
    repl: "canUseCustomProviders(){return!0}",
    sig: /canUseCustomProviders\(\)\{return!0\}/,
    sigAnchor: "canUseCustomProviders(){return!0}",
    required: true,
  },
  {
    name: "P5 wA: drop remoteWorker+TE() disabled branch (keep providers + customModelOverride in RC worker)",
    // wA is the custom-provider mode. It feeds TWO consumers:
    //   (1) customProviderSettings:"disabled"===wA?void 0:VAR.providers  — providers list
    //   (2) ...customModelOverride:wA  — the inference route override (MUST be a real mode)
    // Original: wA="remoteWorker"===CFG.startupMode||TEFN()?"disabled":"sdk"===CFG.startupMode?"sdk":"local"
    // TEFN() = !!process.env.QODER_REMOTE_WORKER, TRUE in the RC worker subprocess -> wA="disabled"
    //   -> providers wiped AND customModelOverride="disabled" -> inference returns empty.
    // Dropping both the "remoteWorker"=== and TEFN() conditions forces wA="local" (or "sdk")
    // in the worker too, fixing BOTH consumers. Stable anchors: the string literals
    // "remoteWorker"/"disabled"/"sdk"/"local" and .startupMode. <cfg> and <te> are backfilled
    // but unused (the whole COND? branch is dropped).
    // NOTE: anchoring wA itself (not a downstream consumer) is required here because wA has a
    // second consumer (customModelOverride) that needs the mode VALUE, not just truthiness.
    anchor: '"remoteWorker"===',
    needle: new RegExp("(?<wa>" + ID + ")=\"remoteWorker\"===(?<cfg>" + ID + ")\\.startupMode\\|\\|(?<te>" + ID + ")\\(\\)\\?\"disabled\":(?<rest2>\"sdk\"===\\k<cfg>\\.startupMode\\?\"sdk\":\"local\")"),
    repl: "$<wa>=$<rest2>",
    sig: new RegExp(ID + "=\"sdk\"===" + ID + "\\.startupMode\\?\"sdk\":\"local\""),
    sigAnchor: '"sdk"===',  // present in patched form, absent in pristine wA assignment
    required: true,
  },
  {
    name: "P4 setModel: bare official name -> this.model redirect",
    // Stable anchors: method setModel, this.model, this._activeModel, literals "string" & "/".
    // <p1> = model param, <p2> = bool param (backfilled via $<p1>/$<p2>). <rest> = the
    // (this.model!==P1||this._activeModel!==P1) head that we splice back after the guard.
    anchor: "=!0){(this.model!==",
    needle: new RegExp("setModel\\((?<p1>" + ID + "),(?<p2>" + ID + ")=!0\\)\\{\\((?<rest>this\\.model!==\\k<p1>\\|\\|this\\._activeModel!==\\k<p1>)"),
    repl: 'setModel($<p1>,$<p2>=!0){if(typeof $<p1>==="string"&&$<p1>&&$<p1>.indexOf("/")<0&&this.model&&this.model.indexOf("/")>0)$<p1>=this.model;($<rest>',
    sig: /setModel\([^,]+,[^,]+=!0\)\{if\(typeof [A-Za-z_$][\w$]*==="string"/,
    sigAnchor: 'if(typeof ',  // present in patched setModel body
    required: false,
  },
  {
    name: "P6 init: force !isServiceAccount (l=0) over deactivate branch",
    // Stable anchors: .isServiceAccount() method, the follow-site !Jd()&&!<l>.
    // <l> = isServiceAccount result var, <auth> = auth facade var. Force <l>=0 so:
    //   - A.loadByok&&!<l> -> runs (BYOK models load into registry)
    //   - <l>?deactivate("service_account"):await initializeCustomProviders() -> initialize runs
    // Sig anchors on the follow-site !Jd()&&!<l> (line right after), since "let ID=0;" alone is
    // too generic to be a safe idempotency signature. Jd = auth-ready gate (1.1.64).
    anchor: ".isServiceAccount();",
    needle: new RegExp("let (?<l>" + ID + ")=(?<auth>" + ID + ")\\.isServiceAccount\\(\\);"),
    repl: "let $<l>=0;",
    sig: new RegExp("let " + ID + "=0;!Jd\\(\\)&&!" + ID),
    sigAnchor: "!Jd()&&",  // present in patched form (follow-site), absent if pristine has l=isServiceAccount
    required: true,
  },
];

// Apply all patches to source. Returns { out, report }. Idempotent: a patch whose sig already
// matches is skipped as "already-patched". Reports MISSING for diagnostics.
//
// Windowed matching for BOTH needle and sig: locate a literal anchor via indexOf (O(n), no
// backtracking), then run the regex only over a ~440-char window around it. This avoids
// catastrophic backtracking from backrefs/ID-wildcards on the full 33MB bundle. `anchor` locates
// the pristine site (for the needle); `sigAnchor` locates the patched site (for idempotency
// detection) — they differ because the patch overwrites the pristine anchor text.
//
// `anchor` may occur multiple times (e.g. "remoteWorker"=== appears in unrelated code); we walk
// every occurrence and patch the first whose window matches the needle.
function applyPatches(src) {
  let out = src;
  const report = [];
  for (const p of PATCHES) {
    // idempotency: sig in a window around sigAnchor
    if (p.sigAnchor) {
      let sIdx = out.indexOf(p.sigAnchor);
      while (sIdx >= 0) {
        const sw = out.slice(Math.max(0, sIdx - WIN), sIdx + p.sigAnchor.length + WIN);
        if (p.sig.test(sw)) { report.push({ name: p.name, status: "already-patched" }); break; }
        sIdx = out.indexOf(p.sigAnchor, sIdx + 1);
      }
      if (report.length && report[report.length - 1].name === p.name && report[report.length - 1].status === "already-patched") continue;
    }
    // needle: walk every anchor occurrence, patch the first window that matches
    let idx = out.indexOf(p.anchor);
    let patched = false;
    while (idx >= 0) {
      const winStart = Math.max(0, idx - WIN);
      const win = out.slice(winStart, idx + p.anchor.length + WIN);
      const m = win.match(p.needle);
      if (m) {
        const mStart = winStart + m.index;
        out = out.slice(0, mStart) + m[0].replace(p.needle, p.repl) + out.slice(mStart + m[0].length);
        report.push({ name: p.name, status: "patched" });
        patched = true;
        break;
      }
      idx = out.indexOf(p.anchor, idx + 1);
    }
    if (!patched) report.push({ name: p.name, status: p.required ? "MISSING (needle no match in any anchor window)" : "n/a (needle absent)" });
  }
  return { out, report };
}

module.exports = { PATCHES, applyPatches, ID };
