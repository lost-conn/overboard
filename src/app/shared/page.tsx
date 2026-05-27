import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getSharedBoard, getProjectParticipants } from "@/lib/board";
import type { ProjectRow } from "@/lib/board";
import { listTags } from "@/lib/tags";
import { Lane } from "@/generated/prisma/enums";
import { logoutAction } from "../(auth)/actions";
import { BoardClient, type ClientProject, type ClientTag } from "../_components/BoardClient";
import styles from "./shared.module.css";

export default async function SharedPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const projects = await getSharedBoard(user.id);
  const clientProjects = projects.map((p) => toClientProject(p, user.id));

  const ownerIds = [...new Set(projects.map((p) => p.userId))];
  const tagsByOwner: Record<string, ClientTag[]> = {};
  const allOwnerTags: ClientTag[] = [];
  if (ownerIds.length > 0) {
    const results = await Promise.all(ownerIds.map((oid) => listTags(oid)));
    ownerIds.forEach((oid, i) => {
      tagsByOwner[oid] = results[i];
      allOwnerTags.push(...results[i]);
    });
  }
  const userTags = await listTags(user.id);
  tagsByOwner[user.id] = userTags;

  const allTags = deduplicateTags([...userTags, ...allOwnerTags]);

  const usedNames = new Set<string>();
  for (const p of clientProjects) {
    for (const lane of ["BACKLOG", "TODO", "DOING", "DONE"] as const) {
      for (const c of p.lanes[lane]) for (const t of c.tags) usedNames.add(t.name);
    }
  }
  const filterTags = allTags.filter((t) => usedNames.has(t.name));

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

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <Link href="/" className={styles.backLink}>
            <ArrowLeft size={14} aria-hidden /> Board
          </Link>
          <h1 className={styles.title}>Shared with me</h1>
        </div>
        <div className={styles.headerActions}>
          <form action={logoutAction}>
            <button className={styles.iconBtn} type="submit">Sign out</button>
          </form>
        </div>
      </header>

      {clientProjects.length === 0 ? (
        <section className={styles.empty}>
          <h2 className={styles.emptyTitle}>No shared projects.</h2>
          <p className={styles.emptyBody}>
            When someone shares a project with you, it will appear here.
          </p>
        </section>
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
    isOwner: false,
    ownerId: p.userId,
    ownerEmail: p.ownerEmail,
    pinnedToBoard: p.pinnedToBoard,
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

function deduplicateTags(tags: ClientTag[]): ClientTag[] {
  const seen = new Map<string, ClientTag>();
  for (const t of tags) {
    if (!seen.has(t.name)) seen.set(t.name, t);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
