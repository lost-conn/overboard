import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { PageHeader } from "../../../_components/AppShell";
import { RestoreBackup } from "./RestoreBackup";
import styles from "./backup.module.css";

export default async function BackupSettingsPage() {
  const session = await currentSession();
  if (!session) redirect("/login");

  return (
    <main className={styles.page}>
      <PageHeader
        title="Backup & restore"
        subtitle="Download everything as one JSON file, or bring one back in. Replace mode deletes your current projects, ideas, and tags before it imports — there is no undo."
      />

      <section className={styles.card}>
        <div className={styles.cardTitle}>Data backup</div>
        <p className={styles.backupHint}>
          Download all projects, cards, ideas, tags, and your component
          vocabulary as a single JSON file.
        </p>
        <a className={styles.submit} href="/api/backup" download>
          Download JSON backup
        </a>
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>Restore backup</div>
        <p className={styles.backupHint}>
          Import a backup JSON. Card assignees and project sharing aren&apos;t
          included in a backup, so they won&apos;t be restored.
        </p>
        <RestoreBackup />
      </section>
    </main>
  );
}
