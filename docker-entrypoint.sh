#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:=file:/app/data/app.db}"
: "${PORT:=3000}"
: "${HOSTNAME:=0.0.0.0}"
: "${NODE_ENV:=production}"
export DATABASE_URL PORT HOSTNAME NODE_ENV

echo "[entrypoint] applying migrations against ${DATABASE_URL}"
node node_modules/prisma/build/index.js migrate deploy

echo "[entrypoint] starting next server on :${PORT}"
exec node node_modules/next/dist/bin/next start --port "${PORT}" --hostname "${HOSTNAME}"
