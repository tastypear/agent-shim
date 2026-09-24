const { Readable, Writable } = require("stream");
const { EventEmitter } = require("events");
const cp = require("child_process");
const Module = require("module");

function install(ctx) {
  const { fs, O, isRemote, toRemote, sRead, sWrite } = ctx;

  fs.createReadStream = (p, opts) => {
    if (isRemote(p)) {
      const d = sRead(toRemote(p));
      const s = new Readable({ read() {} });
      s.push(d);
      s.push(null);
      return s;
    }
    return O.createReadStream.call(fs, p, opts);
  };
  fs.createWriteStream = (p, opts) => {
    if (isRemote(p)) {
      const rp = toRemote(p);
      const ch = [];
      const s = new Writable({ write(c, e, d) { ch.push(c); d(); } });
      s.on("finish", () => sWrite(rp, Buffer.concat(ch)));
      return s;
    }
    return O.createWriteStream.call(fs, p, opts);
  };
  fs.watch = (p, opts, cb) => {
    if (isRemote(p)) {
      const w = new EventEmitter();
      w.close = () => {};
      return w;
    }
    return O.watch.call(fs, p, opts, cb);
  };
  fs.watchFile = (p, opts, cb) => {
    if (isRemote(p)) return;
    return O.watchFile.call(fs, p, opts, cb);
  };

  function FakeTerminal(program, args, options) {
    const child = cp.spawn(program, args, options || {});
    const dh = new Set();
    const eh = new Set();
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => dh.forEach((h) => h(d)));
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => dh.forEach((h) => h(d)));
    }
    child.on("error", () => eh.forEach((h) => h({ exitCode: 1, signal: 0 })));
    child.on("exit", (code, signal) =>
      eh.forEach((h) => h({ exitCode: code ?? 0, signal: typeof signal === "string" ? 1 : 0 }))
    );
    this.pid = child.pid ?? -1;
    this._child = child;
    this.onData = (cb) => { dh.add(cb); return { dispose: () => dh.delete(cb) }; };
    this.onExit = (cb) => { eh.add(cb); return { dispose: () => eh.delete(cb) }; };
    this.write = (data) => { try { child.stdin.write(data); } catch (e) {} };
    this.resize = () => {};
    this.kill = (signal) => { try { child.kill(signal); } catch (e) {} };
  }
  const fakePty = {
    spawn: (p, a, o) => new FakeTerminal(p, a, o),
    WindowsTerminal: FakeTerminal,
    UnixTerminal: FakeTerminal,
  };

  const _load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (typeof request === "string" && (request === "@lydell/node-pty" || request.includes("node-pty"))) {
      return fakePty;
    }
    if (request === "fs/promises" || request === "node:fs/promises") {
      return global.__REMOTE_PROMISES__ || fs.promises;
    }
    return _load.call(this, request, parent, isMain);
  };
}

module.exports = { install };
