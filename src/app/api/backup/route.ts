import { currentSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { joinToChips } from "@/lib/tags";

export async function GET() {
  const session = await currentSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const userId = session.userId;

  const [projects, ideas, tags, classes] = await Promise.all([
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
      include: { tags: { include: { tag: true } } },
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
  ]);

  const backup = {
    version: 1,
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
    ideas: ideas.map(({ userId: _, tags, ...idea }) => ({
      ...idea,
      tags: joinToChips(tags).map((t) => t.name),
    })),
    tags: tags.map(({ userId: _, ...tag }) => tag),
    classes,
  };

  const date = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(backup, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="overboard-backup-${date}.json"`,
    },
  });
}
