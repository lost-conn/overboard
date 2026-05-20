#!/usr/bin/env bash
#
# Auto-deploy overboard-organizer on the host.
#
# Fetches origin/main, fast-forwards if there are new commits, rebuilds the
# Docker image, and restarts the container. Safe to call from cron — it
# resolves its own location, sets PATH, and uses flock so concurrent runs
# don't race.
#
# Usage:
#   scripts/deploy.sh           # deploy only if origin/main has new commits
#   scripts/deploy.sh --force   # deploy regardless of whether anything changed
#   scripts/deploy.sh --help    # show usage
#
# Example crontab entry (every 5 minutes, append output to a log file):
#   */5 * * * * /home/notyou/projects/personal/overboard-organizer/scripts/deploy.sh >> /home/notyou/projects/personal/overboard-organizer/data/deploy.log 2>&1
#
# Requirements on the host:
#   - git, docker (with compose plugin), flock
#   - The user running cron must be in the `docker` group

set -euo pipefail

# Resolve repo root so the script works regardless of cron's working dir.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

# Cron's PATH is minimal; ensure the usual tool locations are reachable.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

usage() {
  cat <<'EOF'
Usage: deploy.sh [--force]

Fetches origin/main, fast-forwards local main if behind, then rebuilds and
restarts the docker compose service.

  --force      Build and restart even if there are no new commits.
  -h, --help   Show this help.
EOF
}

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "deploy.sh: unknown arg '$arg'" >&2; usage >&2; exit 2 ;;
  esac
done

log()  { printf '[deploy %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { log "FAIL: $*"; exit 1; }

# Single-instance lock so overlapping cron runs (slow build, fast tick) skip
# rather than fight each other. /tmp survives reboots being cleared, which is
# what we want — a leftover lockfile from a crashed run shouldn't block forever.
LOCK="/tmp/overboard-deploy.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  log "another deploy is in progress; skipping"
  exit 0
fi

# Refuse to deploy on top of uncommitted local edits — we never want a cron
# job to silently clobber manual changes.
if [ -n "$(git status --porcelain)" ]; then
  fail "working tree is dirty; commit, stash, or reset before deploying"
fi

log "fetching origin"
git fetch --quiet origin main

LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse origin/main)

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ] && [ "$FORCE" -eq 0 ]; then
  log "no changes at ${LOCAL_SHA:0:7}; skipping"
  exit 0
fi

if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  log "new commits: ${LOCAL_SHA:0:7} -> ${REMOTE_SHA:0:7}"
  git pull --ff-only --quiet origin main || fail "non-fast-forward pull (resolve manually)"
elif [ "$FORCE" -eq 1 ]; then
  log "no new commits, --force given; rebuilding anyway"
fi

log "building image"
docker compose build

log "restarting container"
docker compose up -d

# Keep disk usage from growing with every rebuild.
docker image prune -f >/dev/null 2>&1 || true

NEW_SHA=$(git rev-parse HEAD)
log "deploy complete at ${NEW_SHA:0:7}"
