"use strict";

// Consumer-side cache for HTTP mode.
// Phase 3: uses upstream cache provider hook (transport-level caching) +
// batch API for prefetch. No method wrapping except realpath (semantic transform).

var TTL = 60000;
var _cache = new Map();

function _createCacheProvider() {
  return {
    get: function (url) {
      var e = _cache.get(url);
      if (e && Date.now() - e.t < TTL) return e.v;
      if (e) _cache.delete(url);
      return null;
    },
    set: function (url, status, body) {
      _cache.set(url, { v: { statusCode: status, body: body }, t: Date.now() });
    },
    invalidate: function (url) {
      var m = url.match(/[?&]path=([^&]+)/);
      if (m) {
        var enc = m[1];
        var path = decodeURIComponent(enc);
        var parent = path.replace(/\/[^\/]+$/, "") || "/";
        var encParent = encodeURIComponent(parent);
        var keys = Array.from(_cache.keys());
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          if (key.indexOf("path=" + enc + "&") !== -1 || key.endsWith("path=" + enc) ||
              key.indexOf("path=" + encParent + "&") !== -1 || key.endsWith("path=" + encParent)) {
            _cache.delete(key);
          }
        }
      } else {
        _cache.clear();
      }
    }
  };
}

function install(fsObj, isRemote) {
  var client = require("remote-fs-node/lib/client");
  client.setCacheProvider(_createCacheProvider());

  function _norm(p) {
    return Buffer.isBuffer(p) ? p.toString("utf8") : String(p).replace(/\\/g, "/");
  }

  var _realpathSync = fsObj.realpathSync;
  fsObj.realpathSync = function (p, opts) {
    var np = _norm(p);
    if (isRemote(np)) return np;
    try { return _realpathSync.call(fsObj, p, opts); } catch (e) { return np; }
  };
  try { Object.defineProperty(fsObj.realpathSync, "native", { value: fsObj.realpathSync, writable: false, configurable: false }); } catch (_) {}

  var _realpath = fsObj.realpath;
  fsObj.realpath = function (p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    var np = _norm(p);
    if (isRemote(np)) { if (cb) process.nextTick(function () { cb(null, np); }); return; }
    return _realpath.call(fsObj, p, opts, cb);
  };
  try { Object.defineProperty(fsObj.realpath, "native", { value: fsObj.realpath, writable: false, configurable: false }); } catch (_) {}

  if (fsObj.promises && typeof fsObj.promises.realpath === "function") {
    fsObj.promises.realpath = function (p, opts) { return Promise.resolve(fsObj.realpathSync(p, opts)); };
  }

  try {
    var pMod = require("fs/promises");
    if (pMod && pMod !== fsObj.promises && typeof pMod.realpath === "function") {
      var _pmRealpath = pMod.realpath;
      pMod.realpath = function (p, opts) {
        var np = _norm(p);
        if (isRemote(np)) return Promise.resolve(np);
        return _pmRealpath.call(pMod, p, opts);
      };
    }
  } catch (_) {}

  try {
    var bindingMod = require("remote-fs-node/lib/binding");
    if (bindingMod._impl && bindingMod._impl.realpath) {
      bindingMod._impl.realpath = async function (args) { return args[0]; };
    }
  } catch (_) {}
}

function prefetchStartup(exec, cfg, adapter, getRemoteCwd) {
  if (!adapter || !adapter.getPrefetchPaths) return 0;
  var client = require("remote-fs-node/lib/client");

  var cwd = getRemoteCwd();
  var parent = cwd.replace(/\/[^\/]+$/, "") || "/";
  var pf = adapter.getPrefetchPaths(cwd, parent);
  if (!pf) return 0;

  function enc(p) { return encodeURIComponent(p); }
  var ops = [];
  var urlMap = [];

  var existPaths = pf.exists || [];
  for (var i = 0; i < existPaths.length; i++) {
    ops.push({ op: "stat", path: existPaths[i], follow: false });
    urlMap.push("/api/fs/stat?path=" + enc(existPaths[i]) + "&follow=false");
  }

  var statPaths = pf.stat || [];
  for (var i = 0; i < statPaths.length; i++) {
    ops.push({ op: "stat", path: statPaths[i], follow: true });
    urlMap.push("/api/fs/stat?path=" + enc(statPaths[i]) + "&follow=true");
    ops.push({ op: "stat", path: statPaths[i], follow: false });
    urlMap.push("/api/fs/stat?path=" + enc(statPaths[i]) + "&follow=false");
  }

  var readPaths = pf.read || [];
  for (var i = 0; i < readPaths.length; i++) {
    ops.push({ op: "readFile", path: readPaths[i] });
    urlMap.push("/api/fs/read?path=" + enc(readPaths[i]));
  }

  var readdirPaths = pf.readdir || [];
  for (var i = 0; i < readdirPaths.length; i++) {
    ops.push({ op: "readdir", path: readdirPaths[i] });
    urlMap.push("/api/fs/list?path=" + enc(readdirPaths[i]));
  }

  var accessPaths = pf.access || [];
  for (var i = 0; i < accessPaths.length; i++) {
    ops.push({ op: "access", path: accessPaths[i], mode: "0" });
    urlMap.push("/api/fs/access?path=" + enc(accessPaths[i]) + "&mode=0");
    ops.push({ op: "access", path: accessPaths[i], mode: "1" });
    urlMap.push("/api/fs/access?path=" + enc(accessPaths[i]) + "&mode=1");
  }

  if (ops.length === 0) return 0;

  var results;
  try {
    results = client.postJSONSync("/api/fs/batch", { ops: ops }).results;
  } catch (e) {
    return 0;
  }

  for (var i = 0; i < ops.length && i < results.length; i++) {
    var op = ops[i];
    var result = results[i];
    if (!result) continue;
    var url = urlMap[i];

    var body;
    if (result.status >= 400) {
      body = Buffer.from(JSON.stringify(result.body), "utf8");
    } else if (op.op === "readFile") {
      body = Buffer.from(result.body || "", "base64");
    } else if (op.op === "access") {
      body = Buffer.from("");
    } else {
      body = Buffer.from(JSON.stringify(result.body), "utf8");
    }
    var statusCode = (op.op === "access" && result.status < 400) ? 204 : result.status;
    _cache.set(url, { v: { statusCode: statusCode, body: body }, t: Date.now() });
  }

  return ops.length;
}

module.exports = { install: install, prefetchStartup: prefetchStartup };
