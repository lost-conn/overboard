// Preload shim for jkbase's runtime Node, which is built WITHOUT the inspector
// module (a sealed microVM has no use for a debugger). Next 16 unconditionally
// `require("node:inspector")` from node-environment-extensions/console-dim, so on
// such a build it throws ERR_INSPECTOR_NOT_AVAILABLE at startup and crashes
// `next start`. We intercept the require and return a minimal stub.
//
// Self-deactivating: if this Node DOES have a working inspector (e.g. local dev),
// we leave the real module in place and do nothing.
//
// Preloaded via NODE_OPTIONS=--require in jkbase-start.js, so it also covers any
// child node processes Next spawns.
const Module = require("node:module");

let inspectorAvailable = true;
try {
  // Loading throws ERR_INSPECTOR_NOT_AVAILABLE on a --without-inspector build.
  require("node:inspector");
} catch {
  inspectorAvailable = false;
}

if (!inspectorAvailable) {
  class Session {
    connect() {}
    connectToMainThread() {}
    disconnect() {}
    post(_method, params, cb) {
      const done = typeof params === "function" ? params : cb;
      if (typeof done === "function") done(null, {});
    }
    on() {
      return this;
    }
    once() {
      return this;
    }
    off() {
      return this;
    }
    emit() {
      return false;
    }
  }

  // console-dim calls url() (undefined ⇒ no debugger attached, so it dims as
  // normal); the env-gated cpu profiler uses Session. Stub both defensively.
  const stub = {
    url() {
      return undefined;
    },
    open() {},
    close() {},
    waitForDebugger() {},
    Session,
    console: undefined,
  };

  const INSPECTOR = new Set([
    "inspector",
    "node:inspector",
    "inspector/promises",
    "node:inspector/promises",
  ]);

  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (INSPECTOR.has(request)) {
      return stub;
    }
    return originalLoad.call(this, request, ...rest);
  };
}
