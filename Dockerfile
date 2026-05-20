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
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 app \
 && useradd  --system --uid 1001 --gid app --home /app app

COPY --from=builder --chown=app:app /app/package.json ./package.json
COPY --from=builder --chown=app:app /app/package-lock.json ./package-lock.json
COPY --from=builder --chown=app:app /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=app:app /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/.next ./.next
COPY --from=builder --chown=app:app /app/public ./public
COPY --from=builder --chown=app:app /app/src/generated ./src/generated
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/prisma.config.ts ./prisma.config.ts

# SQLite data dir — mounted as a volume by docker-compose so the DB survives
# container rebuilds.
RUN mkdir -p /app/data && chown app:app /app/data

COPY --chown=app:app docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER app
EXPOSE 3000
CMD ["./docker-entrypoint.sh"]
