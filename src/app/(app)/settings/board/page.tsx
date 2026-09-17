import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { setFailedWindowDaysAction } from "@/lib/actions/settings";
import { PageHeader } from "../../../_components/AppShell";
import styles from "./board.module.css";

export default async function BoardSettingsPage() {
  const session = await currentSession();
  if (!session) redirect("/login");

  return (
    <main className={styles.page}>
      <PageHeader
        title="Board settings"
        subtitle="Controls for how the board handles cards that miss their due date."
      />

      <section className={styles.card}>
        <div className={styles.cardTitle}>Failed lane window</div>
        <p className={styles.hint}>
          Cards with <strong>Expires</strong> checked move to the Failed column once their due
          date passes. This is how long they stay visible there before being hidden from the
          board (they aren&apos;t deleted).
        </p>
        <form className={styles.form} action={setFailedWindowDaysAction}>
          <label className={styles.fieldLabel} htmlFor="failedWindowDays">
            Days failed cards stay on the board
          </label>
          <div className={styles.fieldRow}>
            <input
              id="failedWindowDays"
              className={styles.input}
              type="number"
              name="failedWindowDays"
              defaultValue={session.user.failedWindowDays}
              min={1}
              max={365}
              required
            />
            <button className={styles.submit} type="submit">
              Save
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
