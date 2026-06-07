import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getBoardForUser, getProjectParticipants, type ProjectRow } from "@/lib/board";
import { listTags } from "@/lib/tags";
import { Lane } from "@/generated/prisma/enums";
import { logoutAction } from "./(auth)/actions";
import { BoardClient, type ClientProject, type ClientTag } from "./_components/BoardClient";
import { NewProjectButton } from "./_components/NewProjectButton";
import styles from "./page.module.css";

export default async function Home() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const [projects, allTags] = await Promise.all([
    getBoardForUser(user.id),
    listTags(user.id),
  ]);
  const clientProjects = projects.map((p) => toClientProject(p, user.id));

  const ownerIds = [...new Set(
    projects.filter((p) => !p.isOwner).map((p) => p.userId),
  )];
  const tagsByOwner: Record<string, ClientTag[]> = {};
  if (ownerIds.length > 0) {
    const results = await Promise.all(ownerIds.map((oid) => listTags(oid)));
    ownerIds.forEach((oid, i) => { tagsByOwner[oid] = results[i]; });
  }
  tagsByOwner[user.id] = allTags;

  const sharedProjectIds = projects.filter((p) => p.isShared).map((p) => p.id);
  const participantsByProject: Record<string, { id: string; email: string }[]> = {};
  if (sharedProjectIds.length > 0) {
    const { db } = await import("@/lib/db");
    const results = await Promise.all(
      sharedProjectIds.map(async (pid) => {
        const parts = await getProjectParticipants(pid);
        const users = await db.user.findMany({
          where: { id: { in: parts } },
          select: { id: true, email: true },
        });
        return { pid, users };
      }),
    );
    for (const { pid, users } of results) {
      participantsByProject[pid] = users;
    }
  }

  // Filter bar only shows tags actually in use on this view (the board).
  // Tags that exist on ideas but not cards are hidden here — they still appear
  // on /ideas. allTags is still passed in full so the per-card picker can pull
  // from any of the user's tags.
  const usedNames = new Set<string>();
  for (const p of clientProjects) {
    for (const lane of ["BACKLOG", "TODO", "DOING", "DONE"] as const) {
      for (const c of p.lanes[lane]) for (const t of c.tags) usedNames.add(t.name);
    }
  }
  const filterTags = allTags.filter((t) => usedNames.has(t.name));

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>The Overboard</h1>
          <span className={styles.email}>{user.email}</span>
        </div>
        <div className={styles.headerActions}>
          <NewProjectButton />
          <Link className={styles.navLink} href="/ideas">
            Idea pool
          </Link>
          <Link className={styles.navLink} href="/shared">
            Shared
          </Link>
          <Link className={styles.navLink} href="/settings/tokens">
            Tokens
          </Link>
          <form action={logoutAction}>
            <button className={styles.iconBtn} type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>

      {clientProjects.length === 0 ? (
        <EmptyState />
      ) : (
        <BoardClient
          projects={clientProjects}
          allTags={allTags}
          filterTags={filterTags}
          tagsByOwner={tagsByOwner}
          currentUserId={user.id}
          participantsByProject={participantsByProject}
        />
      )}
    </main>
  );
}

function toClientProject(p: ProjectRow, currentUserId: string): ClientProject {
  const lanes: ClientProject["lanes"] = {
    BACKLOG: [],
    TODO: [],
    DOING: [],
    DONE: [],
  };
  for (const lane of [Lane.BACKLOG, Lane.TODO, Lane.DOING, Lane.DONE] as const) {
    lanes[lane] = p.lanes[lane].map((c) => ({
      id: c.id,
      lane: c.lane,
      title: c.title,
      contentJson: parseContent(c.contentJson),
      tags: c.tags,
      assignee: c.assignee ?? null,
    }));
  }
  return {
    id: p.id,
    name: p.name,
    priority: p.priority,
    lanes,
    isShared: p.isShared,
    isOwner: p.isOwner,
    ownerId: p.isOwner ? currentUserId : p.userId,
    ownerEmail: p.ownerEmail,
  };
}

function parseContent(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function EmptyState() {
  return (
    <section className={styles.empty}>
      <h2 className={styles.emptyTitle}>No projects yet.</h2>
      <p className={styles.emptyBody}>
        Each project becomes a row across the board. Lanes (Backlog → To do → Doing → Done) run
        left to right.
      </p>
      <p className={styles.emptyHint}>
        Click <strong>+ New project</strong> in the header to start one, capture rough ideas in
        the <Link href="/ideas">Idea pool</Link>, or seed sample data with{" "}
        <code>npm run seed -- {`<your email>`}</code>.
      </p>
    </section>
  );
}
