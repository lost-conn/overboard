// Node module hooks for `node --test`. Registered via `--import`.
//
// The data layer starts every file with `import "server-only"`, a specifier
// Next's bundler resolves and plain Node does not — the package is never
// installed, it is a compile-time marker that fails the build if server code
// reaches a client bundle. Under `node --test` there is no client bundle to
// protect, so the assertion is vacuous and the import is erased here.
//
// Without this, the whole server-only half of src/lib is untestable, which is
// why only the pure helpers had tests.
//
// `registerHooks` (synchronous, in-thread) rather than `register` on purpose:
// tsx compiles these .ts files to CommonJS, so the specifier arrives through
// `require`, and off-thread `register` hooks are never consulted for that path.
import { registerHooks } from "node:module";

const STUB = new URL("server-only-stub.cjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only" || specifier === "client-only") {
      return { url: STUB, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
