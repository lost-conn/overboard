import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { listAxes } from "@/lib/concepts/axes";
import { PageHeader } from "../../../_components/AppShell";
import { AxesEditor } from "./AxesEditor";
import styles from "./axes.module.css";

export default async function AxesSettingsPage() {
  const session = await currentSession();
  if (!session) redirect("/login");

  const axes = await listAxes(session.userId);

  return (
    <main className={styles.page}>
      <PageHeader
        title="Component axes"
        subtitle="The dimensions you break concepts down along — Mechanic, Setting, Tone, Material. Axes are shared across every concept, so the same component means the same thing in a game and in a story."
      />

      <AxesEditor axes={axes} />
    </main>
  );
}
