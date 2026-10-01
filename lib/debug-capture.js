"use strict";

// debug-capture.js — file-based error logging for diagnosing TUI disappearance.
// Uses the REAL fs (captured before patching) to write to a log file.
// Enable with AGENT_SHIM_DEBUG=1.

const realFs = require("fs");
const path = require("path");

const enabled = process.env.AGENT_SHIM_DEBUG === "1";
const logPath = path.join(__dirname, "..", ".agent-shim-debug.log");

if (enabled) {
  // Truncate log at startup
  try { realFs.writeFileSync(logPath, ""); } catch (e) {}
}

function log(msg) {
  if (!enabled) return;
  try {
    const ts = new Date().toISOString();
    realFs.appendFileSync(logPath, ts + " " + msg + "\n");
  } catch (e) {}
}

function install() {
  if (!enabled) return;

  log("=== agent-shim debug capture started ===");
  log("node " + process.version + " " + process.platform + " " + process.arch);
  log("cwd " + process.cwd());

  process.on("uncaughtException", (e) => {
    log("UNCAUGHT: " + (e && e.stack || e));
  });
  process.on("unhandledRejection", (e) => {
    log("UNHANDLED_REJECTION: " + (e && e.stack || e));
  });
  process.on("exit", (code) => {
    log("PROCESS EXIT code=" + code);
  });

  // Monitor stderr writes — if something writes escape sequences to stderr,
  // it could interfere with the TUI.
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  let stderrBuf = "";
  process.stderr.write = function (data, ...args) {
    if (typeof data === "string" && enabled) {
      // Check for terminal control sequences
      if (data.includes("\x1b[2J") || data.includes("\x1b[?1049") || data.includes("\x1bc")) {
        log("STDERR ESCAPE: " + JSON.stringify(data.slice(0, 100)));
      }
    }
    return origStderrWrite(data, ...args);
  };

  // Monitor stdout writes for terminal control sequences
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (data, ...args) {
    if (typeof data === "string" && enabled) {
      if (data.includes("\x1b[2J") || data.includes("\x1b[?1049") || data.includes("\x1bc")) {
        log("STDOUT ESCAPE: " + JSON.stringify(data.slice(0, 100)));
      }
    }
    return origStdoutWrite(data, ...args);
  };

  log("debug-capture: handlers installed");
}

module.exports = { install, log, enabled, realFs };
