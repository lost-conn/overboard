#!/usr/bin/env bash
set -euo pipefail

echo "[entrypoint] applying migrations against ${DATABASE_URL}"
node node_modules/prisma/build/index.js migrate deploy

echo "[entrypoint] starting next server on :${PORT}"
exec node node_modules/next/dist/bin/next start --port "${PORT}" --hostname "${HOSTNAME}"
