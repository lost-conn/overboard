import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getIdea } from "@/lib/ideas";
import { listTags } from "@/lib/tags";
import {
  getConceptDecomposition,
  getOverlapPartners,
  getVocabulary,
} from "@/lib/concepts/decomposition";
import { getLadderStatus } from "@/lib/concepts/ladder";
import { NotFoundError } from "@/lib/errors";
import { ConceptBoard } from "./ConceptBoard";
import styles from "./concept.module.css";

export default async function ConceptPage({
  params,
}: {
  params: Promise<{ conceptId: string }>;
}) {
  const { conceptId } = await params;
  const user = await currentUser();
  if (!user) redirect("/login");

  // The fetch is wrapped, not the JSX: React renders components lazily, so a
  // try/catch around the returned tree would never see a render-time error
  // anyway — it would only hide the real intent of the catch.
  let data;
  try {
    data = await Promise.all([
      getIdea(user.id, conceptId),
      getConceptDecomposition(user.id, conceptId),
      getVocabulary(user.id),
      listTags(user.id),
      getOverlapPartners(user.id, conceptId),
      getLadderStatus(user.id, conceptId),
    ]);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const [idea, decomposition, vocabulary, allTags, partners, ladder] = data;

  // Every axis the user owns, declared on this concept or not: demoting files
  // the concept under one, and that choice isn't limited to the axes it happens
  // to have declared for itself.
  const axes = [
    ...decomposition.axes.map((a) => ({ id: a.axisId, name: a.name, color: a.color })),
    ...decomposition.undeclaredAxes.map((a) => ({ id: a.id, name: a.name, color: a.color })),
  ];

  return (
    <main className={styles.page}>
      <ConceptBoard
        conceptId={idea.id}
        title={idea.title}
        contentJson={parseContent(idea.contentJson)}
        tags={idea.tags}
        allTags={allTags}
        decomposition={decomposition}
        vocabulary={vocabulary}
        partners={partners}
        ladder={ladder}
        axes={axes}
      />
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
