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
//   P7  Primary working directory: strip vCwd prefix   — (non-BYOK) hide /◦host∶port/ in prompt
//   P8  env snapshot: inject BYOK models from cps      — new-page model list shows BYOK models
//   P9  Read/Edit "File does not exist" error: strip   — (non-BYOK) hide /◦host∶port/ in error cwd note
//
// P7 is a separate concern (prompt hygiene, not BYOK) but shares the same hook/patcher infra.
// It strips the virtual-workspace prefix from the "Primary working directory:" line in the
// system prompt so the AI sees the real remote path, not /◦host∶port/root. The prefix MUST stay
// in process.cwd() / path.resolve(cwd) (session-key hash depends on it — see classifier.js), so
// the strip is localized to this one prompt splice only.
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
//   P8 snapshot let-chain: let y=D(k),M=m(k),F=process.env[hbA]  (offset ~27990230)
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
  'let y=(function(r){',
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
  'if(process.env.AGENT_SHIM_BYOK_DEBUG==="1"){var _c=0;if(r)for(var _q=0;_q<r.length;_q++)if(r[_q]&&r[_q].source==="custom")_c++;console.error("[byok-p8] injected "+_c+" custom models (snapshot total "+(r?r.length:0)+")")}',
  '}',
  'catch(e){}',
  'return r;',
  '})(D(k)),M=m(k),F=process.env[hbA]',
].join("");

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
  {
    name: "P7 prompt: strip vCwd prefix from Primary working directory",
    // The system prompt's # Environment block splices `Primary working directory: ${VAR}` where
    // VAR = config.getWorkingDir() = the virtual cwd /◦host∶port/root. The prefix leaks into the
    // prompt (cosmetic noise + the AI may copy it into bash commands). Strip it HERE only — the
    // prefix must remain in process.cwd()/path.resolve(cwd) because qoder's session-key hash
    // (CB, non-normalizing) buckets by the exact prefixed string (see classifier.js).
    // Stable anchor: the literal "Primary working directory: " (unique in the bundle). <v> is the
    // minified working-dir var, backfilled into a .replace() that drops /◦host∶port/ (◦ U+25E6,
    // ∶ U+2236). The strip regex mirrors classifier.js WORKSPACE_PREFIX_RE.
    anchor: "Primary working directory: ",
    needle: new RegExp("Primary working directory: \\$\\{(?<v>" + ID + ")\\}"),
    repl: 'Primary working directory: ${$<v>.replace(/\\/\\u25E6[a-zA-Z0-9.\\-:]+\\u2236\\d+\\//,"/")}',
    sig: /Primary working directory: \$\{[A-Za-z_$][\w$]*\.replace\(\/\\\/\\u25E6/,
    sigAnchor: "Primary working directory: ${",
    required: false,
  },
  {
    name: "P8 env snapshot: inject BYOK custom models from customProviderSettings",
    // The environment metadata snapshot (available_models, shown on the "new session" page) is
    // D(k)=xn().getModelsForConfiguredScene() taken in the BROKER process. BYOK models only enter
    // the registry via replaceLocalModels, which runs in the WORKER (session) process — so the
    // broker snapshot never has them, and the new-page model list can't show BYOK models until a
    // session is created. The broker's config k DOES carry customProviderSettings (the providers
    // from settings.json, kept alive by P5), so we can construct custom-model entries from it and
    // append them to the snapshot here. Entry format mirrors what the worker produces (verified
    // field-for-field against session available_models). Optional fallback; if formats diverge in
    // a future version the worst case is a misrendered list entry, not a crash (guarded).
    anchor: "let y=D(k),M=m(k),F=process.env[hbA]",
    // needle matches the full let-chain head; <cfg> backfills k. We wrap D(k) in an IIFE that
    // appends custom entries (deduped by modelId) before returning.
    needle: new RegExp("let y=D\\((?<cfg>" + ID + ")\\),M=m\\(\\k<cfg>\\),F=process\\.env\\[hbA\\]"),
    repl: P8_REPL,
    // sig/sigAnchor match the ACTUAL injected IIFE head (var cps=, not a stale diag var). The
    // sigAnchor is the IIFE-open literal — present only in the patched form (the pristine site is
    // `let y=D(k),M=m(k)`), so indexOf returns -1 on pristine and we fall straight through to the
    // needle; on patched it locates the one injection site and the sig confirms it.
    sig: /let y=\(function\(r\)\{try\{var cps=/,
    sigAnchor: "(function(r){try{var cps=",
    required: false,
  },
  {
    name: "P9 Read/Edit error: strip vCwd prefix from getTargetDir() in 'File does not exist' message",
    // The Read/Edit "File does not exist" error splices `this.config.getTargetDir()` into the
    // message text, which carries the /◦host∶port/ prefix. Strip it HERE only — same .replace
    // as P7. The prefix must remain in process.cwd()/path.resolve(cwd) for session-key hash
    // bucketing (see classifier.js). Two identical sites (Read + Edit), hence multi: true.
    // Stable anchor: "File does not exist. " (string literal). <u> is the minified "Note: your
    // current working directory is " var (UKA in 1.1.64), backfilled via $<u>.
    anchor: "File does not exist. ",
    needle: new RegExp("File does not exist\\. \\$\\{(?<u>" + ID + ")\\} \\$\\{this\\.config\\.getTargetDir\\(\\)\\}\\."),
    repl: 'File does not exist. ${$<u>} ${this.config.getTargetDir().replace(/\\/\\u25E6[a-zA-Z0-9.\\-:]+\\u2236\\d+\\//,"/")}.',
    sig: /File does not exist\. \$\{[A-Za-z_$][\w$]*\} \$\{this\.config\.getTargetDir\(\)\.replace\(\/\\\/\\u25E6/,
    sigAnchor: "File does not exist. ${",
    required: false,
    multi: true,
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
    if (p.multi) {
      // Multi-site: patch ALL occurrences matching needle, skip per-occurrence if sig matches.
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
