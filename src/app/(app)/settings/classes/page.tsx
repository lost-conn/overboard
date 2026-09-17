import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { listClasses } from "@/lib/board/classes";
import { PageHeader } from "../../../_components/AppShell";
import { ClassesEditor } from "./ClassesEditor";
import styles from "./classes.module.css";

export default async function ClassesSettingsPage() {
  const session = await currentSession();
  if (!session) redirect("/login");

  const classes = await listClasses(session.userId);

  return (
    <main className={styles.page}>
      <PageHeader
        title="Schedule classes"
        subtitle="Reusable weekly/monthly windows you can assign to projects, so they only show up on the board when they're actually relevant."
      />

      <ClassesEditor classes={classes} />
    </main>
  );
}
