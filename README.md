# Overboard Organizer

A self-hosted kanban board for people whose side-projects backlog has
its own scrollbar. Live instance: **<https://ob.lostconnection.dev>**.

The pitch: one mega-board, one row per project, lanes Backlog → To do
→ Doing → Done. Ideas you haven't committed to yet live in a separate
Idea Pool until they earn the promotion to a real row.

## What it does

- **Mega-board view.** Every project is a row; lanes are columns; cards
  drag around within and between lanes. Project rows sort themselves by
  recent activity (cards in DOING and TODO weigh heaviest, with an
  exponential time-decay on edits), with a small numeric **priority**
  field on each row as the manual override — lower number sorts higher,
  defaults to 1, can be 0 or negative if you want something pinned to
  the very top.
- **WYSIWYG card editor** with headings, lists, code, links, and most
  importantly task lists, because half the reason a project stalls is
  that the next step is actually three steps.
- **Idea Pool.** A separate page for the "wouldn't it be nice if…"
  tier. Promote an idea and it becomes a project row carrying any notes
  you took along the way.
- **Multi-user with strict isolation.** Anyone can register; nobody can
  see anyone else's data. A public auth system in service of a private
  database, which is — on reflection — a single-tenant app with extra
  steps. That was the requirement.
- **MCP server.** The board exposes itself over the Model Context
  Protocol at `/api/mcp`, so Claude (or any MCP client) can list, create,
  move, and delete cards on your behalf. Bearer-token auth, minted at
  `/settings/tokens`. Useful for "remind me to do X" voice notes that
  end up as backlog cards without you having to open the laptop.

## Stack

- **Next.js 16** (App Router, Turbopack) on **React 19**
- **Prisma 7** with the **better-sqlite3** driver adapter
- **TipTap 3** (StarterKit + task lists) for the card editor
- **dnd-kit** for the drag-and-drop
- **Radix UI Dialog** for the editor drawer
- **CSS Modules** for styles. No Tailwind, intentionally.
- Session auth is hand-rolled: ~120 lines of `bcrypt` + cookies + a
  `Session` table. Every off-the-shelf auth library wanted to bring
  along either a UI it owned, a flow it prescribed, or a session
  strategy that didn't fit. The whole auth module is now the smallest
  file in the project, which is the kind of thing you want auth to be.

## Quick start (Docker)

```bash
git clone git@github.com:lost-conn/overboard.git
cd overboard
docker compose up -d --build
```

The container binds to `127.0.0.1:10946`, on the assumption that a
reverse proxy on the host is doing the public-facing work. A Caddy
snippet looks like:

```caddy
overboard.example.com {
    reverse_proxy 127.0.0.1:10946 {
        flush_interval -1
        transport http {
            response_header_timeout 5m
            read_timeout 5m
        }
    }
}
```

The `flush_interval` + bumped timeouts are for the MCP endpoint —
default Caddy upstream timeout (30s) is fine for the web UI but tight
for any long-running tool call. If you don't plan to use MCP, the bare
`reverse_proxy 127.0.0.1:10946` form is enough.

The SQLite database lives at `./data/app.db` via a bind mount, so it
survives image rebuilds and backups are literally `cp data/app.db
backup-$(date +%F).db`.

The entrypoint runs `prisma migrate deploy` before starting the
server, so schema changes land automatically on the next deploy.

## Auto-deploy from cron

`scripts/deploy.sh` is the cron-friendly half of all of this. It:

- Fetches `origin/main`, fast-forwards if there are new commits
- Refuses to run on a dirty tree (no silent stomping of manual edits)
- Uses `flock` so overlapping ticks during a slow build don't race
- Rebuilds the image and restarts the container
- Prunes dangling images so disk usage stays roughly constant

```cron
*/5 * * * * /home/<you>/overboard/scripts/deploy.sh >> /home/<you>/overboard/data/deploy.log 2>&1
```

`scripts/deploy.sh --force` skips the new-commits check and rebuilds
anyway. Useful when you've edited the compose file or just want a
fresh container without backdating a commit to trigger it.

## Local dev

```bash
npm install
echo 'DATABASE_URL=file:./data/app.db' > .env
npx prisma migrate dev
npm run dev
```

Then open `http://localhost:3000` and register an account. If you'd
rather not stare at an empty grid, `npm run seed -- you@example.com`
will plant three sample projects with about a dozen cards.

To hit the dev server from a phone or another machine on your LAN,
add the LAN IP (or a pattern) to `allowedDevOrigins` in
`next.config.ts`. Next 16 blocks cross-origin requests to dev assets
by default; the symptom is that the page renders but every `onClick`
silently does nothing, which is the kind of bug that takes a
suspiciously long time to diagnose.

## Notable design decisions

- **SQLite, not Postgres.** This is a single-process app for a
  single-laptop deployment. Anything more would be cosplay.
- **Server Actions for the UI, one route handler for MCP.** Browser
  mutations are server actions with a `userId` guard from the session
  cookie. The MCP endpoint at `/api/mcp` is the lone exception: it
  resolves a bearer token to a `userId` and calls the same core
  functions the server actions wrap. The actions and the MCP tools both
  delegate to `src/lib/board/mutations.ts` and `src/lib/ideas/mutations.ts`
  so ownership checks and validation only exist in one place.
- **Optimistic local state for drag-and-drop.** The board updates
  before the network request finishes. `revalidatePath('/')` reconciles
  if anything drifts.
- **No backups in-repo.** The DB is one file on disk; back it up the
  way you back up anything else on the laptop, or don't. I haven't yet.

## MCP usage

Mint a token at `/settings/tokens`. It's shown once, then stored as a
SHA-256 hash — copy it somewhere before leaving the page. Tokens grant
full access to your data, so revoke any you don't recognize.

Wire it into Claude Code:

```bash
claude mcp add overboard --transport http \
  https://overboard.example.com/api/mcp \
  --header "Authorization: Bearer ob_pat_..."
```

Then in a Claude session, `/mcp` lists the tools and you can ask things
like "what's on my To do list across all projects" or "add a card to
the 'Home server' project to replace the UPS battery".

The tool surface is roughly: `list_projects`, `create_project`,
`rename_project`, `archive_project`, `delete_project`, `list_cards`,
`get_card`, `create_card`, `update_card`, `move_card`, `delete_card`,
`list_ideas`, `create_idea`, `update_idea`, `delete_idea`,
`promote_idea`, `whoami`. Bodies sent over MCP are stored as plain
text and synced to a minimal TipTap doc, so they show up in the web
editor and round-trip cleanly. Rich formatting (bold, links, task
lists) still has to be authored in the web UI.

One caveat: MCP mutations skip the `revalidatePath` calls the web UI
relies on. If you have the board open in another tab while Claude is
editing it, you'll need to refresh to see the changes.

## License

MIT. See `LICENSE`.
