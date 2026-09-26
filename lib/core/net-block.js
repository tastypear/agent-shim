// lib/core/net-block.js
// Generic path-based HTTP request short-circuit. Wraps http.request / https.request
// (and the ClientRequest constructors) so that any outbound request whose URL path
// matches an entry in the blockPaths list is intercepted: instead of opening a real
// socket, a synthetic ClientRequest is returned that emits an empty 200 response.
//
// This is path-level, not host-level: only the exact paths an adapter declares are
// short-circuited. Everything else (login, auth, chat, userinfo) flows through
// untouched. fetch/undici are NOT patched here — if an agent routes a given path
// through fetch instead of http.request, the adapter must opt into a fetch wrapper.
//
// Core contains no agent strings. The path list comes from the adapter.

const http = require("http");
const https = require("https");
const { EventEmitter } = require("events");
const { Readable } = require("stream");

function isBlocked(args, blockPaths) {
  // http.request(url, options, cb) | http.request(options, cb)
  // The path may live in a URL string or an options object.
  let path = null;
  for (const a of args) {
    if (!a) continue;
    if (typeof a === "string") {
      try { path = new URL(a).pathname; } catch (e) { /* not a URL */ }
    } else if (a instanceof URL) {
      path = a.pathname;
    } else if (typeof a === "object" && typeof a.path === "string") {
      path = a.path.split("?")[0];
    } else if (typeof a === "object" && typeof a.pathname === "string") {
      path = a.pathname;
    }
    if (path) break;
  }
  if (!path) return false;
  // Strip query string defensively.
  path = path.split("?")[0];
  return blockPaths.some((p) => path === p || path.startsWith(p + "/"));
}

// Build a fake ClientRequest that never touches the network. It mimics enough of
// http.ClientRequest for POST-and-read-response callers (status code + empty body):
// write/end are no-ops returning true; 'response' fires once with a synthetic Incoming
// message carrying statusCode 200 and an empty body; 'close'/'error' behave sanely.
function syntheticRequest() {
  const req = new EventEmitter();
  req.writableEnded = false;
  req.writableFinished = false;
  req.destroyed = false;
  req.aborted = false;
  req.write = function () { return true; };
  req.end = function (cb) {
    this.writableEnded = true;
    this.writableFinished = true;
    const res = new Readable({ read() { this.push(null); } });
    res.statusCode = 200;
    res.statusMessage = "OK";
    res.headers = {};
    res.rawHeaders = [];
    res.httpVersion = "1.1";
    res.complete = true;
    process.nextTick(() => {
      this.emit("response", res);
      if (typeof cb === "function") cb();
      this.emit("close");
    });
    return this;
  };
  req.setTimeout = function () { return this; };
  req.setNoDelay = function () { return this; };
  req.setSocketKeepAlive = function () { return this; };
  req.flushHeaders = function () {};
  req.getHeader = function () { return undefined; };
  req.setHeader = function () { return this; };
  req.removeHeader = function () { return this; };
  req.abort = function () { this.aborted = true; this.emit("close"); };
  req.destroy = function (err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (err) this.emit("error", err);
    this.emit("close");
    return this;
  };
  req.on = EventEmitter.prototype.on;
  req.once = EventEmitter.prototype.once;
  req.emit = EventEmitter.prototype.emit;
  req.addListener = EventEmitter.prototype.addListener;
  req.removeListener = EventEmitter.prototype.removeListener;
  req.removeAllListeners = EventEmitter.prototype.removeAllListeners;
  req.unref = function () { return this; };
  req.ref = function () { return this; };
  return req;
}

function install(blockPaths) {
  if (!blockPaths || !blockPaths.length) return;
  const paths = blockPaths.map(String);

  for (const mod of [http, https]) {
    const origRequest = mod.request;
    mod.request = function (...args) {
      if (isBlocked(args, paths)) return syntheticRequest();
      return origRequest.apply(this, args);
    };
    // http.get calls http.request internally and attaches a 'response' handler; since
    // our wrapper returns the same shape, get keeps working. But some callers use the
    // get shorthand directly — wrap it too for consistency.
    const origGet = mod.get;
    if (typeof origGet === "function") {
      mod.get = function (...args) {
        if (isBlocked(args, paths)) {
          const req = syntheticRequest();
          // http.get auto-ends the request; emulate that.
          process.nextTick(() => req.end());
          return req;
        }
        return origGet.apply(this, args);
      };
    }
  }
}

module.exports = { install };
