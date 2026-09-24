// test/tool-simulation.js
// Simulate qoder's built-in tools (Read, Edit, Write, Glob, Grep) to verify
// they work correctly through the launcher on the real remote (QUIC).

const cp = require("child_process");
const fs = require("fs");
const path = require("path");

require("../lib/index.js");

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
  if (!ready) { console.error("SFTP not ready"); process.exit(2); }
  console.log("SFTP ready (QUIC remote).\n");

  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    console.log(`[${cond ? "PASS" : "FAIL"}] ${label}: ${detail}`);
    cond ? pass++ : fail++;
  };

  const TEST_FILE = "/root/qoder-tool-test.txt";
  const TEST_DIR = "/root";

  // === Write tool (fs.writeFileSync) ===
  try {
    fs.writeFileSync(TEST_FILE, "line1\nline2\nline3\n", "utf8");
    ok("Write: writeFileSync", true, `wrote ${TEST_FILE}`);
  } catch (e) {
    ok("Write: writeFileSync", false, e.message.slice(0, 80));
  }

  // === Read tool (fs.readFileSync) ===
  try {
    const content = fs.readFileSync(TEST_FILE, "utf8");
    ok("Read: readFileSync", content === "line1\nline2\nline3\n", `content=${JSON.stringify(content)}`);
  } catch (e) {
    ok("Read: readFileSync", false, e.message.slice(0, 80));
  }

  // === Read: statSync (file info) ===
  try {
    const st = fs.statSync(TEST_FILE);
    ok("Read: statSync", st.size > 0 && st.isFile(), `size=${st.size} isFile=${st.isFile()}`);
  } catch (e) {
    ok("Read: statSync", false, e.message.slice(0, 80));
  }

  // === Read: existsSync ===
  try {
    const ex = fs.existsSync(TEST_FILE);
    const nex = fs.existsSync("/root/nonexistent-xyz-123");
    ok("Read: existsSync", ex === true && nex === false, `exists=${ex} nonexistent=${nex}`);
  } catch (e) {
    ok("Read: existsSync", false, e.message.slice(0, 80));
  }

  // === Glob tool (fs.readdirSync) ===
  try {
    const entries = fs.readdirSync(TEST_DIR);
    const hasTest = entries.includes("qoder-tool-test.txt");
    ok("Glob: readdirSync", Array.isArray(entries) && entries.length > 0 && hasTest,
       `entries=${entries.length} hasTest=${hasTest}`);
  } catch (e) {
    ok("Glob: readdirSync", false, e.message.slice(0, 80));
  }

  // === Glob: readdirSync with withFileTypes ===
  try {
    const entries = fs.readdirSync(TEST_DIR, { withFileTypes: true });
    const testEntry = entries.find((e) => e.name === "qoder-tool-test.txt");
    ok("Glob: readdirSync+withFileTypes", !!testEntry && testEntry.isFile(),
       `found=${!!testEntry} isFile=${testEntry ? testEntry.isFile() : "?"}`);
  } catch (e) {
    ok("Glob: readdirSync+withFileTypes", false, e.message.slice(0, 80));
  }

  // === Grep tool (spawn rg) ===
  {
    const child = cp.spawn("rg", ["line2", "."], { cwd: TEST_DIR, stdio: "pipe" });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    const r = await new Promise((res) => child.on("close", (c) => res({ out: out.trim(), code: c })));
    ok("Grep: rg search", r.out.includes("line2") && r.code === 0,
       `out=${JSON.stringify(r.out.slice(0, 60))} code=${r.code}`);
  }

  // === Grep: rg with --files (list files) ===
  {
    const child = cp.spawn("rg", ["--files"], { cwd: TEST_DIR, stdio: "pipe" });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    const r = await new Promise((res) => child.on("close", (c) => res({ out: out.trim(), code: c })));
    ok("Grep: rg --files", r.out.includes("qoder-tool-test.txt") && r.code === 0,
       `found test file=${r.out.includes("qoder-tool-test.txt")} code=${r.code}`);
  }

  // === Edit tool (write tmp + rename) ===
  try {
    const tmpPath = TEST_FILE + ".tmp";
    fs.writeFileSync(tmpPath, "edited-content\n", "utf8");
    fs.renameSync(tmpPath, TEST_FILE);
    const content = fs.readFileSync(TEST_FILE, "utf8");
    ok("Edit: write+rename", content === "edited-content\n", `content=${JSON.stringify(content)}`);
  } catch (e) {
    ok("Edit: write+rename", false, e.message.slice(0, 80));
  }

  // === Edit: openSync+writeSync+closeSync (qoder's Write tool pattern) ===
  try {
    const fd = fs.openSync(TEST_FILE, "w");
    fs.writeSync(fd, "fd-based-write\n");
    fs.closeSync(fd);
    const content = fs.readFileSync(TEST_FILE, "utf8");
    ok("Edit: openSync+writeSync+closeSync", content === "fd-based-write\n",
       `content=${JSON.stringify(content)}`);
  } catch (e) {
    ok("Edit: openSync+writeSync+closeSync", false, e.message.slice(0, 80));
  }

  // === Edit: appendFileSync ===
  try {
    fs.appendFileSync(TEST_FILE, "appended\n", "utf8");
    const content = fs.readFileSync(TEST_FILE, "utf8");
    ok("Edit: appendFileSync", content === "fd-based-write\nappended\n",
       `content=${JSON.stringify(content)}`);
  } catch (e) {
    ok("Edit: appendFileSync", false, e.message.slice(0, 80));
  }

  // === fs.promises.readFile ===
  try {
    const content = await fs.promises.readFile(TEST_FILE, "utf8");
    ok("Read: promises.readFile", content.includes("fd-based-write"), `content=${JSON.stringify(content.slice(0, 40))}`);
  } catch (e) {
    ok("Read: promises.readFile", false, e.message.slice(0, 80));
  }

  // === fs.promises.writeFile ===
  try {
    await fs.promises.writeFile(TEST_FILE, "promise-write\n", "utf8");
    const content = fs.readFileSync(TEST_FILE, "utf8");
    ok("Write: promises.writeFile", content === "promise-write\n", `content=${JSON.stringify(content)}`);
  } catch (e) {
    ok("Write: promises.writeFile", false, e.message.slice(0, 80));
  }

  // === fs.promises.stat ===
  try {
    const st = await fs.promises.stat(TEST_FILE);
    ok("Read: promises.stat", st.isFile() && st.size > 0, `size=${st.size}`);
  } catch (e) {
    ok("Read: promises.stat", false, e.message.slice(0, 80));
  }

  // === Cleanup ===
  try { fs.unlinkSync(TEST_FILE); } catch (e) {}

  // === mkdirSync + rmdirSync ===
  try {
    const dir = "/root/.qoder-test-dir";
    fs.mkdirSync(dir);
    const ex1 = fs.existsSync(dir);
    fs.rmdirSync(dir);
    const ex2 = fs.existsSync(dir);
    ok("FS: mkdir+rmdir", ex1 && !ex2, `created=${ex1} removed=${!ex2}`);
  } catch (e) {
    ok("FS: mkdir+rmdir", false, e.message.slice(0, 80));
  }

  // === realpath variants ===
  try {
    const r1 = fs.realpathSync("/root");
    const r2 = fs.realpathSync.native("/root");
    const r3 = await fs.promises.realpath("/root");
    ok("FS: realpath variants", r1 === "/root" && r2 === "/root" && r3 === "/root",
       `sync=${r1} native=${r2} promise=${r3}`);
  } catch (e) {
    ok("FS: realpath variants", false, e.message.slice(0, 80));
  }

  console.log(`\nTool simulation: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(3); });
