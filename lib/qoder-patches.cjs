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
// Version pins (minified names observed in 1.1.64/1.1.65, for future drift diagnosis):
//   P5 condition var: wA  (wA="remoteWorker"===i.startupMode||TE()?"disabled":"sdk"===i.startupMode?"sdk":"local")
//                     TE() = !!process.env.QODER_REMOTE_WORKER — TRUE in RC worker subprocess
//   P5 providers var: A
//   P6 <l> (isServiceAccount result): l    <n> (auth facade): n
//   P6 auth-ready gate: Jd (1.1.64) / Gd (1.1.65) — wildcarded in sig
//   P6 follow-site sigAnchor: "config-service skipped" (stable log literal, unique)
//   P4 setModel params: (A, e=!0)
//   P8 snapshot let-chain: let y=D(k),...  (1.1.64: M=m(k),F=env[hbA]; 1.1.65: F=m(k),M=env[FbA])
//       Needle matches only `let <y>=<D>(<cfg>),` — variable reorder across versions is handled.
//       <cfg> = k (the config var, carries .customProviderSettings in the broker)

const ID = "[A-Za-z_$][\\w$]*";

// Performance: regexes with backrefs/ID wildcards catastrophic-backtrack on the 33MB bundle
// if run over the full source. Each patch has an `anchor` — a literal stable substring — used
// to indexOf-locate the site, then the needle regex runs only over a small window around it.
// This keeps O(n) total (indexOf is linear, window regex is ~constant) while preserving the
// semantic-wildcard matching (no minified names hardcoded).
const WIN = 220; // chars of context each side of the anchor — enough for every needle below

// P8 replacement: wraps D(k) in an IIFE that appends BYOK custom-model entries (constructed from
// the config's customProviderSettings) to the snapshot array, deduped by modelId. <cfg> is the
// minified config var (backfilled). Built as a plain string to keep the injected JS readable.
// The construction mirrors the worker's custom entry format (tags/model/value/format/source/
// modelId/provider/isEnabled/displayName/maxInputTokens/maxOutputTokens/availableContextWindows).
const P8_REPL = [
  'let $<y>=(function(r){',
  'try{',
  'var cps=$<cfg>.customProviderSettings;',
  'if(cps&&typeof cps==="object"){',
  'var seen={};',
  'if(r){for(var i=0;i<r.length;i++){var kk=r[i]&&(r[i].modelId||r[i].value);if(kk)seen[kk]=1}}',
  'for(var pk in cps){',
  'var prov=cps[pk];',
  'if(!prov||typeof prov!=="object")continue;',
  'var ms=Array.isArray(prov.models)?prov.models:[];',
  'for(var j=0;j<ms.length;j++){',
  'var mm=ms[j];',
  'var mdl=(mm&&mm.model)||prov.model;',
  'if(!mdl)continue;',
  'var id=pk+"/"+mdl;',
  'if(seen[id])continue;',
  'seen[id]=1;',
  'var ctx=(mm&&mm.contextWindow)||128000;',
  'r=r||[];',
  'r.push({tags:["custom-provider"],model:mdl,value:id,format:"openai",source:"custom",modelId:id,provider:pk,isEnabled:true,description:"",displayName:(mm&&mm.displayName)||prov.displayName||mdl,descriptionEn:"",maxInputTokens:ctx,maxOutputTokens:(mm&&mm.maxOutputTokens)||32000,availableContextWindows:[ctx]});',
  '}}}',
  'if(process.env.AGENT_SHIM_DEBUG==="1"){var _c=0;if(r)for(var _q=0;_q<r.length;_q++)if(r[_q]&&r[_q].source==="custom")_c++;console.error("[p8] injected "+_c+" custom models (snapshot total "+(r?r.length:0)+")")}',
  '}',
  'catch(e){}',
  'return r;',
  '})($<D>($<cfg>)),',
].join("");

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
    anchor: '"remoteWorker"===',
    needle: new RegExp("(?<wa>" + ID + ")=\"remoteWorker\"===(?<cfg>" + ID + ")\\.startupMode\\|\\|(?<te>" + ID + ")\\(\\)\\?\"disabled\":(?<rest2>\"sdk\"===\\k<cfg>\\.startupMode\\?\"sdk\":\"local\")"),
    repl: "$<wa>=$<rest2>",
    sig: new RegExp(ID + "=\"sdk\"===" + ID + "\\.startupMode\\?\"sdk\":\"local\""),
    sigAnchor: '"sdk"===',
    required: true,
  },
  {
    name: "P4 BYOK model routing",
    anchor: "=!0){(this.model!==",
    needle: new RegExp("setModel\\((?<p1>" + ID + "),(?<p2>" + ID + ")=!0\\)\\{\\((?<rest>this\\.model!==\\k<p1>\\|\\|this\\._activeModel!==\\k<p1>)"),
    repl: 'setModel($<p1>,$<p2>=!0){if(typeof $<p1>==="string"&&$<p1>&&$<p1>.indexOf("/")<0&&this.model&&this.model.indexOf("/")>0)$<p1>=this.model;($<rest>',
    sig: /setModel\([^,]+,[^,]+=!0\)\{if\(typeof [A-Za-z_$][\w$]*==="string"/,
    sigAnchor: 'if(typeof ',
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
    name: "P8 BYOK model list on new-session page",
    anchor: "continuing daemon startup",
    needle: new RegExp("let (?<y>" + ID + ")=(?<D>" + ID + ")\\((?<cfg>" + ID + ")\\),"),
    repl: P8_REPL,
    sig: /let [A-Za-z_$][\w$]*=\(function\(r\)\{try\{var cps=/,
    sigAnchor: "(function(r){try{var cps=",
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
