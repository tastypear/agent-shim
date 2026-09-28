// lib/byok-hook.mjs — non-invasive ESM load hook for BYOK patching.
// Registered by lib/index.js (via module.register) when AGENT_SHIM_BYOK=1. Intercepts the
// qodercli.js ESM load, applies the shared BYOK patches in memory, and returns the patched
// source — without touching the bundle file on disk. Works in the RC worker subprocesses too:
// they inherit NODE_OPTIONS (so they load the shim and register this hook) and bail before the
// platform-faking path, but the hook is already installed and patches their qodercli.js load.
import { readFileSync, appendFileSync } from "node:fs";
import pkg from "./byok-patches.cjs";
const { applyPatches } = pkg;

let bundleUrl = null;
const DEBUG = process.env.AGENT_SHIM_BYOK_DEBUG === "1";
const LOG = "C:/tmp/byok-hook.txt";
function log(obj) {
  if (!DEBUG) return;
  try { appendFileSync(LOG, JSON.stringify({ ...obj, pid: process.pid }) + "\n"); } catch (_) {}
}

export function initialize(data) {
  bundleUrl = (data && data.bundleUrl) || null;
  if (bundleUrl) log({ ev: "init", bundleUrl });
  return {};
}

export async function load(url, context, nextLoad) {
  if (!bundleUrl || url !== bundleUrl) return nextLoad(url, context);
  const base = await nextLoad(url, context);
  let src;
  try {
    src = readFileSync(new URL(url), "utf8");
  } catch (e) {
    log({ ev: "read-fail", url, err: String(e && e.message) });
    return base;
  }
  const { out, report } = applyPatches(src);
  log({ ev: "load", url, report: report.map(r => r.status + ":" + r.name) });
  return { format: base.format || "module", source: out, shortCircuit: true };
}
