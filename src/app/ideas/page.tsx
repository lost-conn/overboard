import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getIdeasForUser } from "@/lib/ideas";
import { logoutAction } from "../(auth)/actions";
import { IdeasClient, type ClientIdea } from "../_components/IdeasClient";
import styles from "./ideas.module.css";

export default async function IdeasPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const ideas = await getIdeasForUser(user.id);
  const clientIdeas: ClientIdea[] = ideas.map((i) => ({
    id: i.id,
    title: i.title,
    contentJson: parseContent(i.contentJson),
  }));

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <Link href="/" className={styles.backLink}>
            <ArrowLeft size={14} aria-hidden /> Board
          </Link>
          <h1 className={styles.title}>Idea pool</h1>
          <span className={styles.email}>{user.email}</span>
        </div>
        <div className={styles.headerActions}>
          <form action={logoutAction}>
            <button className={styles.iconBtn} type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <IdeasClient ideas={clientIdeas} />
    </main>
  );
}

function parseContent(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
