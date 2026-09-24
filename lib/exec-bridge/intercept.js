const { Readable, Writable } = require("stream");
const { EventEmitter } = require("events");

function makeRuntimeInfoChild() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({ write(c, e, d) { d(); } });
  child.pid = undefined;
  child.exitCode = 1;
  child.signalCode = null;
  child.unref = () => child;
  child.ref = () => child;
  child.kill = () => true;
  setTimeout(() => {
    child.stdout.push(Buffer.from("{\n"));
    child.stdout.push(null);
    child.stderr.push(Buffer.from("intercepted Linux ELF on Windows\n"));
    child.stderr.push(null);
    child.emit("close", 1, null);
  }, 50);
  return child;
}

module.exports = { makeRuntimeInfoChild };
