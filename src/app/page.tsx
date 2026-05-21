import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getBoardForUser, type ProjectRow } from "@/lib/board";
import { listTags } from "@/lib/tags";
import { Lane } from "@/generated/prisma/enums";
import { logoutAction } from "./(auth)/actions";
import { BoardClient, type ClientProject } from "./_components/BoardClient";
import { NewProjectButton } from "./_components/NewProjectButton";
import styles from "./page.module.css";

export default async function Home() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const [projects, allTags] = await Promise.all([
    getBoardForUser(user.id),
    listTags(user.id),
  ]);
  const clientProjects = projects.map(toClientProject);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>Overboard Organizer</h1>
          <span className={styles.email}>{user.email}</span>
        </div>
        <div className={styles.headerActions}>
          <NewProjectButton />
          <Link className={styles.navLink} href="/ideas">
            Idea pool
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
        <BoardClient projects={clientProjects} allTags={allTags} />
      )}
    </main>
  );
}

function toClientProject(p: ProjectRow): ClientProject {
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
    }));
  }
  return { id: p.id, name: p.name, priority: p.priority, lanes };
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
