// qoder bundle patches — general (apply in both local and remote mode).
// Consumed by lib/qoder-hook.mjs (non-invasive ESM load hook) and
// tools/qoder-byok-patch.cjs (invasive file patcher).
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
//   P8  env snapshot: inject BYOK models from cps      — new-page model list shows BYOK models
//
// Version pins (minified names observed, for future drift diagnosis):
//   1.1.64/1.1.65: P5 wA/TE/A, P6 l/n, P4 (A,e=!0)+this.model, P8 let y=D(k) snapshot IIFE.
//     The 1.1.65 P8 form is gone — kept in knowledge-base/qoder-patches.md for archaeology.
//   1.1.84: P5 <wa>=<cd>()?"disabled":... (<cd>()=!!QODER_REMOTE_WORKER via r0=ki("REMOTE_WORKER")).
//     P4: async setModel(A,e=!0){let ... — this.model removed, current key is this.getModel().
//     P8: projectSessionListedModels filter (see patch entry). getModelsForConfiguredScene +
//     customModelOverride no longer exist.

const ID = "[A-Za-z_$][\\w$]*";

// Performance: regexes with backrefs/ID wildcards catastrophic-backtrack on the 33MB bundle
// if run over the full source. Each patch has an `anchor` — a literal stable substring — used
// to indexOf-locate the site, then the needle regex runs only over a small window around it.
// This keeps O(n) total (indexOf is linear, window regex is ~constant) while preserving the
// semantic-wildcard matching (no minified names hardcoded).
const WIN = 220; // chars of context each side of the anchor — enough for every needle below

// P8 (1.1.84+): extend projectSessionListedModels' source filter to admit custom-provider
// entries. See the patch entry below and knowledge-base/qoder-patches.md for the full chain
// (Iq warm-up -> Rci/JEc normalized entries -> IPA filter -> x6u mapper -> metadata.available_models).

const PATCHES = [
  {
    name: "P1 BYOK access gate bypass",
    anchor: "canUseCustomProviders(){return",
    needle: /canUseCustomProviders\(\)\{return[^{}]*\}/,
    repl: "canUseCustomProviders(){return!0}",
    sig: /canUseCustomProviders\(\)\{return!0\}/,
    sigAnchor: "canUseCustomProviders(){return!0}",
    required: true,
  },
  {
    name: "P5 BYOK activation in RC worker",
    // 1.1.84: <wa>=<cd>()?"disabled":"sdk"===<cfg>.startupMode?"sdk":"local"  (<cd>() = !!QODER_REMOTE_WORKER)
    // 1.1.64: <wa>="remoteWorker"===<cfg>.startupMode||<te>()?"disabled":...
    // Dropping the worker-detect branch keeps providers + access mode alive in RC workers.
    anchor: '?"disabled":"sdk"===',
    needle: new RegExp("(?<wa>" + ID + ")=(?<cd>" + ID + ")\\(\\)\\?\"disabled\":\"sdk\"===(?<cfg>" + ID + ")\\.startupMode\\?\"sdk\":\"local\""),
    repl: '$<wa>="sdk"===$<cfg>.startupMode?"sdk":"local"',
    sig: new RegExp(ID + "=\"sdk\"===" + ID + "\\.startupMode\\?\"sdk\":\"local\""),
    sigAnchor: '"sdk"===',
    required: true,
  },
  {
    name: "P4 BYOK model routing",
    // 1.1.84: async setModel(A,e=!0){let t=++this.modelSelectionRevision,...
    // this.model is gone; the current model key is this.getModel(). Inject the bare-name
    // redirect at the head: bare official name -> pinned custom route (key has "/").
    anchor: "async setModel(",
    needle: new RegExp("async setModel\\((?<p1>" + ID + "),(?<p2>" + ID + ")=!0\\)\\{let "),
    repl: 'async setModel($<p1>,$<p2>=!0){if(typeof $<p1>==="string"&&$<p1>&&$<p1>.indexOf("/")<0&&this.getModel()&&this.getModel().indexOf("/")>0)$<p1>=this.getModel();let ',
    sig: /setModel\([^,]+,[^,]+=!0\)\{if\(typeof [A-Za-z_$][\w$]*==="string"/,
    sigAnchor: '=!0){if(typeof ',
    required: false,
  },
  {
    name: "P6 BYOK activation for service accounts",
    anchor: ".isServiceAccount();",
    needle: new RegExp("let (?<l>" + ID + ")=(?<auth>" + ID + ")\\.isServiceAccount\\(\\);"),
    repl: "let $<l>=0;",
    sig: new RegExp("let " + ID + "=0;!" + ID + "\\(\\)&&!" + ID),
    sigAnchor: "config-service skipped",
    required: true,
  },
  {
    // 1.1.84 rework: the new-session model list comes from projectSessionListedModels
    // (a.k.a. IPA) which projects ONLY source==="qoder" entries, even though the
    // composite provider (Iq) already warms up custom-provider models natively
    // (Rci builds them from project settings; JEc normalizes them with source
    // = providerId and key = "providerId/modelId"). Extend the filter to also
    // admit those JEc-shaped entries: key contains "/", and capabilities/limits
    // are present (required by the x6u entry mapper). Fixes the new-session page
    // AND in-session listed model lists (buildSessionModelList/buildLiveSessionModelList
    // share IPA).
    name: "P8 BYOK models in listed model lists",
    anchor: '"qoder"===',
    needle: new RegExp("for\\(let (?<e>" + ID + ") of (?<arr>" + ID + ")\\)\"qoder\"===\\k<e>\\.source&&\\("),
    repl: 'for(let $<e> of $<arr>)("qoder"===$<e>.source||"string"==typeof $<e>.key&&$<e>.key.indexOf("/")>0&&$<e>.capabilities&&$<e>.limits)&&(',
    sig: /\)\("qoder"===[A-Za-z_$][\w$]*\.source\|\|/,
    sigAnchor: ')("qoder"===',
    required: false,
  },
];

// Apply all patches to source. Returns { out, report }. Idempotent: a patch whose sig already
// matches is skipped as "already-patched". Reports MISSING for diagnostics.
function applyPatches(src, patches) {
  const list = patches || PATCHES;
  let out = src;
  const report = [];
  for (const p of list) {
    if (p.multi) {
      let idx = out.indexOf(p.anchor);
      let patchCount = 0, alreadyCount = 0;
      while (idx >= 0) {
        const winStart = Math.max(0, idx - WIN);
        const win = out.slice(winStart, idx + p.anchor.length + WIN);
        if (p.sig && p.sig.test(win)) { alreadyCount++; idx = out.indexOf(p.anchor, idx + 1); continue; }
        const m = win.match(p.needle);
        if (m) {
          const mStart = winStart + m.index;
          const replacement = m[0].replace(p.needle, p.repl);
          out = out.slice(0, mStart) + replacement + out.slice(mStart + m[0].length);
          patchCount++;
          idx = out.indexOf(p.anchor, mStart + replacement.length);
        } else {
          idx = out.indexOf(p.anchor, idx + 1);
        }
      }
      if (patchCount > 0) report.push({ name: p.name, status: "patched (" + patchCount + " site" + (patchCount > 1 ? "s" : "") + ")" });
      else if (alreadyCount > 0) report.push({ name: p.name, status: "already-patched" });
      else report.push({ name: p.name, status: p.required ? "MISSING (needle no match in any anchor window)" : "n/a (needle absent)" });
      continue;
    }
    if (p.sigAnchor) {
      let sIdx = out.indexOf(p.sigAnchor);
      while (sIdx >= 0) {
        const sw = out.slice(Math.max(0, sIdx - WIN), sIdx + p.sigAnchor.length + WIN);
        if (p.sig.test(sw)) { report.push({ name: p.name, status: "already-patched" }); break; }
        sIdx = out.indexOf(p.sigAnchor, sIdx + 1);
      }
      if (report.length && report[report.length - 1].name === p.name && report[report.length - 1].status === "already-patched") continue;
    }
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

module.exports = { PATCHES, applyPatches, ID, WIN };
