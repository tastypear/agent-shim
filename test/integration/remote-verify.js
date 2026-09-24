// test/integration/remote-verify.js
// End-to-end checks against a real SSH/SFTP remote. Standalone script (not node:test)
// because loading lib/index.js patches fs/child_process globally, which interferes with
// the node:test runner's own internals.
//
// Opt-in: requires a config (AGENT_SHIM_CONFIG or REMOTE_BRIDGE_CONFIG).
//   node test/integration/remote-verify.js
// or via npm: npm run test:integration  (sets AGENT_SHIM_INTEGRATION=1)
// `npm test` (unit) does not run this.

const cp = require("child_process");
const fs = require("fs");

if (!process.env.AGENT_SHIM_CONFIG && !process.env.REMOTE_BRIDGE_CONFIG) {
  console.error("skip: set AGENT_SHIM_CONFIG or REMOTE_BRIDGE_CONFIG to a remote config");
  process.exit(0);
}

require("../../lib/index.js");

const TEST_FILE = "/root/agent-shim-integ.txt";
const TEST_DIR = "/root";
let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${label}: ${detail}`);
  cond ? pass++ : fail++;
};

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitForSftp() {
  for (let i = 0; i < 60; i++) {
    if (global.__sftpExecAsync) {
      try {
        const r = await global.__sftpExecAsync("echo READY");
        if (r.stdout.toString().trim() === "READY") return true;
      } catch (e) {}
    }
    await wait(500);
  }
  return false;
}

async function main() {
  const ready = await waitForSftp();
  if (!ready) { console.error("SFTP not ready within 30s"); process.exit(2); }
  console.log("SFTP ready.\n");

  // write + read round-trip
  try {
    fs.writeFileSync(TEST_FILE, "line1\nline2\n", "utf8");
    ok("write+read", fs.readFileSync(TEST_FILE, "utf8") === "line1\nline2\n", "round-trip");
  } catch (e) { ok("write+read", false, e.message.slice(0, 80)); }

  // statSync + existsSync
  try {
    const st = fs.statSync(TEST_FILE);
    ok("stat+exists", st.isFile() && st.size > 0 && fs.existsSync(TEST_FILE) && !fs.existsSync("/root/__nope__xyz"),
       `size=${st.size}`);
  } catch (e) { ok("stat+exists", false, e.message.slice(0, 80)); }

  // readdirSync + withFileTypes
  try {
    const names = fs.readdirSync(TEST_DIR);
    const dents = fs.readdirSync(TEST_DIR, { withFileTypes: true });
    const me = dents.find((d) => d.name === "agent-shim-integ.txt");
    ok("readdir+dirent", Array.isArray(names) && names.length > 0 && me && me.isFile(), `entries=${names.length}`);
  } catch (e) { ok("readdir+dirent", false, e.message.slice(0, 80)); }

  // rg spawn (pipe stdio) routes remote
  {
    const child = cp.spawn("rg", ["line2", "."], { cwd: TEST_DIR, stdio: "pipe" });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    const r = await new Promise((res) => child.on("close", (c) => res({ out: out.trim(), code: c })));
    ok("rg spawn", r.code === 0 && /line2/.test(r.out), `code=${r.code}`);
  }

  // concurrent spawns do not serialize
  {
    const mk = () => new Promise((res) => {
      const c = cp.spawn("rg", ["--files"], { cwd: TEST_DIR, stdio: "pipe" });
      let out = ""; c.stdout.on("data", (d) => (out += d.toString()));
      c.on("close", () => res(out));
    });
    const t0 = Date.now();
    const [a, b, c] = await Promise.all([mk(), mk(), mk()]);
    const dt = Date.now() - t0;
    ok("concurrent spawn", a.length > 0 && b.length > 0 && c.length > 0 && dt < 15000, `3x rg in ${dt}ms`);
  }

  // execFile callback captures stdout/stderr
  {
    const r = await new Promise((res) => {
      cp.execFile("sh", ["-c", "echo out; echo err 1>&2"], { cwd: TEST_DIR }, (err, stdout, stderr) =>
        res({ stdout: stdout.trim(), stderr: stderr.trim() }));
    });
    ok("execFile callback", r.stdout === "out" && r.stderr === "err", `out=${r.stdout} err=${r.stderr}`);
  }

  // fd-based write
  try {
    const fd = fs.openSync(TEST_FILE, "w");
    fs.writeSync(fd, "fd-write\n");
    fs.closeSync(fd);
    ok("fd write", fs.readFileSync(TEST_FILE, "utf8") === "fd-write\n", "openSync+writeSync+closeSync");
  } catch (e) { ok("fd write", false, e.message.slice(0, 80)); }

  // fs.promises
  try {
    await fs.promises.writeFile(TEST_FILE, "promise\n", "utf8");
    const content = await fs.promises.readFile(TEST_FILE, "utf8");
    const st = await fs.promises.stat(TEST_FILE);
    ok("fs.promises", content === "promise\n" && st.isFile(), "readFile/writeFile/stat");
  } catch (e) { ok("fs.promises", false, e.message.slice(0, 80)); }

  // realpath variants
  try {
    const r1 = fs.realpathSync("/root");
    const r2 = fs.realpathSync.native("/root");
    const r3 = await fs.promises.realpath("/root");
    ok("realpath", r1 === "/root" && r2 === "/root" && r3 === "/root", `sync/native/promise`);
  } catch (e) { ok("realpath", false, e.message.slice(0, 80)); }

  try { fs.unlinkSync(TEST_FILE); } catch (e) {}
  console.log(`\nIntegration: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(3); });
