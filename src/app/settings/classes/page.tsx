import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { listClasses } from "@/lib/board/classes";
import { ClassesEditor } from "./ClassesEditor";
import styles from "./classes.module.css";

export default async function ClassesSettingsPage() {
  const session = await currentSession();
  if (!session) redirect("/login");

  const classes = await listClasses(session.userId);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Schedule classes</h1>
          <p className={styles.subtitle}>
            Reusable weekly/monthly windows you can assign to projects, so they only show up on
            the board when they&apos;re actually relevant.
          </p>
        </div>
        <div className={styles.headerLinks}>
          <Link className={styles.back} href="/settings/tokens">
            Tokens
          </Link>
          <Link className={styles.back} href="/settings/board">
            Board settings
          </Link>
          <Link className={styles.back} href="/">
            ← Board
          </Link>
        </div>
      </header>

      <ClassesEditor classes={classes} />
    </main>
  );
}
