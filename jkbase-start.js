// Launch wrapper for jkbase's Node buildpack.
//
// The buildpack execs ONE direct `node` command with no entrypoint script, so the
// migration step that used to live in docker-entrypoint.sh has to run here, in
// process, before the server boots. PORT and HOSTNAME are injected by the platform
// (HOSTNAME=0.0.0.0); DATABASE_URL comes from a jkbase secret and is read by
// prisma.config.ts (which is why dotenv is a runtime dependency, not a dev one).
const { spawnSync, spawn } = require("node:child_process");

const node = process.execPath;

// 1. Apply pending migrations. better-sqlite3 / the volume at /app/data make this
//    create-or-migrate the live DB file before any request lands.
//
//    Prisma 7 fetches its schema engine lazily over the network, but this VM is
//    network-fenced. So we vendor the engine binary in the repo (prisma/engines/)
//    and point Prisma straight at it — the same binary + env the build phase uses
//    (see package.json `build`). The path is relative to cwd (/app at runtime).
const migrate = spawnSync(
  node,
  ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PRISMA_SCHEMA_ENGINE_BINARY:
        "prisma/engines/schema-engine-debian-openssl-3.0.x",
    },
  }
);
if (migrate.status !== 0) {
  console.error(`[jkbase-start] migrate deploy failed (exit ${migrate.status})`);
  process.exit(migrate.status ?? 1);
}

// 2. Hand off to the Next production server. It reads PORT from the env and defaults
//    the hostname to 0.0.0.0, both of which the platform sets.
const next = spawn(node, ["node_modules/next/dist/bin/next", "start"], {
  stdio: "inherit",
});

// Forward shutdown signals so Next drains cleanly (jkbase does a graceful hand-off).
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => next.kill(sig));
}
next.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
