"use strict";
// Subprocess helper: runs a remote command via remote-cp-node's streaming spawn,
// pipes stdout/stderr to this process's stdout/stderr (which are the fds qoder
// passed to spawn), and exits with the remote exit code. qoder sees a real
// ChildProcess — identical to local execution.
//
// Args: [0]=cmd [1]=baseURL [2]=token [3]=remote-cp-node module path
const cmd = process.argv[2];
const baseURL = process.argv[3];
const token = process.argv[4];
const modulePath = process.argv[5];

if (!cmd || !baseURL || !modulePath) {
  process.stderr.write("stream-helper: missing arguments\n");
  process.exit(127);
}

let remoteCp;
try {
  remoteCp = require(modulePath);
} catch (e) {
  process.stderr.write("stream-helper: cannot load remote-cp-node: " + e.message + "\n");
  process.exit(127);
}

remoteCp.configure({ baseURL, token });

const child = remoteCp.spawn(cmd, [], { shell: true });

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

let exited = false;
let lastCode = 0;
function done(code, sig) {
  if (exited) return;
  exited = true;
  if (sig) {
    try { process.kill(process.pid, sig); } catch (_) { process.exit(code || 0); }
  } else {
    process.exit(code || 0);
  }
}
child.on("exit", (code, sig) => { lastCode = code || 0; done(code, sig); });
child.on("close", () => done(lastCode, null));
child.on("error", (err) => {
  if (exited) return;
  exited = true;
  process.stderr.write(err.message + "\n");
  process.exit(127);
});

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => { try { child.kill(sig); } catch (_) {} });
}
