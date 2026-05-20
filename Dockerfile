# syntax=docker/dockerfile:1.7

# ---- deps ------------------------------------------------------------------
# Install all npm deps. Build tools are needed because better-sqlite3 compiles
# a native binding via node-gyp.
FROM node:25-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder ---------------------------------------------------------------
# Generate the Prisma client (writes TS into src/generated/prisma/) and build
# the Next.js app. Then drop devDependencies from node_modules so we can copy
# a slim tree into the runner.
FROM node:25-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build
RUN npm prune --omit=dev

# ---- runner ----------------------------------------------------------------
# Minimal runtime image. We deliberately copy the full pruned node_modules
# rather than relying on Next standalone output — the Prisma CLI (for
# `migrate deploy`) has a deep transitive tree (effect, @prisma/config,
# @prisma/debug, ...) that standalone's tracer can't see because the CLI is
# invoked outside the Next runtime.
FROM node:25-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATABASE_URL=file:/app/data/app.db

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Use the `node` user that already ships with the official image (uid/gid 1000).
# This matches typical single-user Linux hosts (the first regular user is 1000),
# so the SQLite file created in the bind-mounted ./data dir has consistent
# ownership across the container and the host.
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/package-lock.json ./package-lock.json
COPY --from=builder --chown=node:node /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/src/generated ./src/generated
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/prisma.config.ts ./prisma.config.ts

# SQLite data dir — mounted as a volume by docker-compose so the DB survives
# container rebuilds. Ownership is overlaid by the host bind mount at runtime.
RUN mkdir -p /app/data && chown node:node /app/data

COPY --chown=node:node docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER node
EXPOSE 3000
CMD ["./docker-entrypoint.sh"]
