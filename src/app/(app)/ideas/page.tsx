import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getIdeasForUser } from "@/lib/ideas";
import { listTags } from "@/lib/tags";
import { PageHeader } from "../../_components/AppShell";
import { IdeasClient, type ClientIdea } from "../../_components/IdeasClient";
import styles from "./ideas.module.css";

export default async function IdeasPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const [ideas, allTags] = await Promise.all([
    getIdeasForUser(user.id),
    listTags(user.id),
  ]);
  const clientIdeas: ClientIdea[] = ideas.map((i) => ({
    id: i.id,
    title: i.title,
    contentJson: parseContent(i.contentJson),
    tags: i.tags,
  }));

  // Filter bar only shows tags actually in use on ideas; allTags stays full
  // for the per-idea tag picker.
  const usedNames = new Set<string>();
  for (const i of clientIdeas) for (const t of i.tags) usedNames.add(t.name);
  const filterTags = allTags.filter((t) => usedNames.has(t.name));

  return (
    <main className={styles.page}>
      <div className={styles.head}>
        <PageHeader title="Idea pool" subtitle="Rough notes that aren't projects yet." />
      </div>

      <IdeasClient ideas={clientIdeas} filterTags={filterTags} />
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
