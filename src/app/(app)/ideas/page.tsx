import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { listTags } from "@/lib/tags";
import { getPoolDecomposition, getVocabulary } from "@/lib/concepts/decomposition";
import { PageHeader } from "../../_components/AppShell";
import { PoolClient } from "../../_components/PoolClient";
import styles from "./ideas.module.css";

export default async function IdeasPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const [concepts, vocabulary, allTags] = await Promise.all([
    getPoolDecomposition(user.id),
    getVocabulary(user.id),
    listTags(user.id),
  ]);

  // Filter bar only shows tags actually in use on concepts; the full tag list
  // stays available wherever tags are edited.
  const usedNames = new Set<string>();
  for (const c of concepts) for (const t of c.tags) usedNames.add(t.name);
  const filterTags = allTags.filter((t) => usedNames.has(t.name));

  return (
    <main className={styles.page}>
      <div className={styles.head}>
        <PageHeader
          title="Idea pool"
          subtitle="Concepts and the components they're made of. Hover or pin a component to see everything else built from it."
        />
      </div>

      <PoolClient concepts={concepts} vocabulary={vocabulary} filterTags={filterTags} />
    </main>
  );
}
