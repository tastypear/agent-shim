// lib/qoder-hook.mjs — non-invasive ESM load hook for qoder bundle patching.
// Registered by lib/index.js (via module.register). Intercepts the qodercli.js ESM load,
// applies patches in memory, and returns the patched source — without touching the bundle file
// on disk. Works in RC worker subprocesses: they inherit NODE_OPTIONS (so they load the shim
// and register this hook) and bail before the platform-faking path, but the hook is already
// installed and patches their qodercli.js load.
import { readFileSync, appendFileSync } from "node:fs";
import general from "./qoder-patches.cjs";
import remote from "./qoder-remote-patches.cjs";

const { applyPatches } = general;

let bundleUrl = null;
const DEBUG = process.env.AGENT_SHIM_DEBUG === "1";
const LOG = "C:/tmp/qoder-hook.txt";
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

  let out = src;
  let allReports = [];

  // General patches (BYOK unlock/activation/routing) — always apply unless DISABLE_BYOK.
  if (!process.env.DISABLE_BYOK) {
    const result = applyPatches(out, general.PATCHES);
    out = result.out;
    allReports.push(...result.report);
  }

  // Remote-only patches (prefix stripping) — only when AGENT_SHIM_REMOTE=1 and not DISABLE_REMOTE_DISPLAY.
  if (process.env.AGENT_SHIM_REMOTE === "1" && !process.env.DISABLE_REMOTE_DISPLAY) {
    const result = applyPatches(out, remote.PATCHES);
    out = result.out;
    allReports.push(...result.report);
  }

  log({ ev: "load", url, report: allReports.map(r => r.status + ":" + r.name) });

  // Print all patch results to stderr so the user sees them on startup.
  for (const r of allReports) {
    process.stderr.write("[agent-shim] patch " + r.name + " — " + r.status + "\n");
  }

  return { format: base.format || "module", source: out, shortCircuit: true };
}
