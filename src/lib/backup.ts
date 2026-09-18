import "server-only";
import { db } from "@/lib/db";
import { joinToChips } from "@/lib/tags";

// The export half of the backup feature. Lives here rather than inside
// src/app/api/backup/route.ts so that the route is a thin HTTP wrapper and the
// tests can exercise the *shipping* exporter instead of a copy of it.
//
// That copy is not hypothetical: restore.test.ts used to carry its own Prisma
// select and payload shape, so emptying the real route's `axes` key left the
// whole suite green. A backup that silently stops carrying the vocabulary is
// precisely the failure this feature exists to prevent, so the thing under test
// has to be the thing that ships.
//
// Import counterpart: src/lib/restore.ts.

/**
 * v1: projects, cards, ideas, tags, classes.
 * v2: adds the component vocabulary (axes, components), each concept's
 *     decomposition, and the promotion-ladder links.
 *
 * The ladder fields were added to v2 rather than minting a v3 on purpose: they
 * are additive and optional, so an older v2 file simply has none of them and
 * restores exactly as it does today. Bumping the version would instead make
 * every already-deployed server reject new files outright (parseBackup refuses
 * anything newer than it supports), which is strictly worse for no gain.
 */
export const BACKUP_VERSION = 2;

/**
 * Everything in one user's account that a backup carries, already shaped the
 * way parseBackup expects to read it back.
 *
 * Fields are listed explicitly rather than rest-spread from the row. A spread
 * carries whatever column was added to the schema last, restore ignores it, and
 * the field sits in the file looking preserved while being dropped on the way
 * back in — which is exactly how the promotion ladder's three columns came to
 * be exported but not restored. Explicit lists keep the export and the import
 * describing the same set of things, and backup.test.ts pins the key lists so
 * that adding a column forces the decision rather than defaulting to silence.
 */
export type BackupPayload = Awaited<ReturnType<typeof buildBackupPayload>>;

export async function buildBackupPayload(userId: string) {
  const [projects, ideas, tags, classes, axes, components] = await Promise.all([
    db.project.findMany({
      where: { userId },
      orderBy: [{ priority: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        priority: true,
        archived: true,
        createdAt: true,
        omnipresent: true,
        cards: {
          orderBy: { order: "asc" },
          select: {
            id: true,
            lane: true,
            order: true,
            title: true,
            contentJson: true,
            contentMd: true,
            createdAt: true,
            dueAt: true,
            expires: true,
            failedAt: true,
            rescuedAt: true,
            doneAt: true,
            recurrence: true,
            seriesId: true,
            tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
          },
        },
        classLinks: { where: { userId }, select: { classId: true } },
      },
    }),
    db.idea.findMany({
      where: { userId },
      orderBy: { order: "asc" },
      select: {
        id: true,
        order: true,
        title: true,
        contentJson: true,
        contentMd: true,
        createdAt: true,
        // The promotion ladder. A demoted concept is still a row here, hidden
        // from the pool, twinned with the component it became. Drop these and a
        // restore hands the user that one thing back twice: a live concept and
        // its mirror component, with nothing to say they were ever the same.
        projectId: true,
        mirrorComponentId: true,
        demotedAt: true,
        tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
        // The decomposition itself. Both joins cascade off Idea, so a replace
        // restore deletes every one of them — without these two arrays the
        // concepts come back undecomposed and nothing says so.
        axes: { orderBy: { order: "asc" }, select: { axisId: true, order: true } },
        components: {
          orderBy: { order: "asc" },
          select: { componentId: true, order: true },
        },
      },
    }),
    db.tag.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: { name: true, color: true },
    }),
    db.projectClass.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, tz: true, windows: true },
    }),
    db.axis.findMany({
      where: { userId },
      orderBy: { order: "asc" },
      select: { id: true, name: true, description: true, color: true, order: true },
    }),
    db.component.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        description: true,
        contentJson: true,
        axisId: true,
      },
    }),
  ]);

  return {
    // v2 added the component vocabulary (axes, components) and each concept's
    // decomposition. A v1 backup carries no vocabulary at all, which restore.ts
    // has to tell apart from "a v2 backup of an empty vocabulary" — otherwise a
    // replace restore from an old file would wipe a vocabulary it cannot refill.
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    // Ids throughout are this server's own. Restore never writes them; it
    // remaps them old -> new by *name* (classes, axes, components) or via a
    // within-file id map (a card's seriesId, a concept's projectId and
    // mirrorComponentId), so importing into an account that already has a
    // vocabulary merges into it rather than colliding with it.
    projects: projects.map(({ cards, classLinks, ...proj }) => ({
      ...proj,
      classIds: classLinks.map((l) => l.classId),
      cards: cards.map(({ tags: cardTags, ...card }) => ({
        ...card,
        tags: joinToChips(cardTags).map((t) => t.name),
      })),
    })),
    ideas: ideas.map(({ tags: ideaTags, ...idea }) => ({
      ...idea,
      tags: joinToChips(ideaTags).map((t) => t.name),
    })),
    tags,
    classes,
    axes,
    components,
  };
}

/** The exact bytes the download endpoint returns. */
export async function buildBackupFile(userId: string): Promise<string> {
  return JSON.stringify(await buildBackupPayload(userId), null, 2);
}

export function backupFilename(now: Date = new Date()): string {
  return `overboard-backup-${now.toISOString().slice(0, 10)}.json`;
}
