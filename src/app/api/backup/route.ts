import { currentSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { joinToChips } from "@/lib/tags";

export async function GET() {
  const session = await currentSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const userId = session.userId;

  const [projects, ideas, tags, classes, axes, components] = await Promise.all([
    db.project.findMany({
      where: { userId },
      orderBy: [{ priority: "asc" }, { name: "asc" }],
      include: {
        cards: {
          orderBy: { order: "asc" },
          include: { tags: { include: { tag: true } } },
        },
        classLinks: { where: { userId }, select: { classId: true } },
      },
    }),
    db.idea.findMany({
      where: { userId },
      orderBy: { order: "asc" },
      include: {
        tags: { include: { tag: true } },
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

  const backup = {
    // v2 added the component vocabulary (axes, components) and each concept's
    // decomposition. A v1 backup carries no vocabulary at all, which restore.ts
    // has to tell apart from "a v2 backup of an empty vocabulary" — otherwise a
    // replace restore from an old file would wipe a vocabulary it cannot refill.
    version: 2,
    exportedAt: new Date().toISOString(),
    // classIds here are this server's ProjectClass.id values — restore.ts
    // remaps them old->new the same way it remaps seriesId, matching by
    // class *name* against the `classes` list below.
    projects: projects.map(({ userId: _, cards, classLinks, ...proj }) => ({
      ...proj,
      classIds: classLinks.map((l) => l.classId),
      cards: cards.map(({ tags, ...card }) => ({
        ...card,
        tags: joinToChips(tags).map((t) => t.name),
      })),
    })),
    ideas: ideas.map(({ userId: _, tags, axes: ideaAxes, components: ideaComponents, ...idea }) => ({
      ...idea,
      tags: joinToChips(tags).map((t) => t.name),
      // axisId/componentId here are this server's ids. Restore remaps them
      // old->new by *name*, the same way classIds are remapped, so importing
      // into an account that already has a vocabulary merges into it.
      axes: ideaAxes,
      components: ideaComponents,
    })),
    tags: tags.map(({ userId: _, ...tag }) => tag),
    classes,
    axes,
    components,
  };

  const date = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(backup, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="overboard-backup-${date}.json"`,
    },
  });
}
