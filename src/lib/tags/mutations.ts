import "server-only";
import { db } from "@/lib/db";
import { ValidationError, NotFoundError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";

const MAX_NAME_LEN = 32;
const MAX_TAGS_PER_ITEM = 16;

function emitBoard(userId: string): void {
  publish(userId, { type: "board", at: new Date().toISOString() });
}

// Lowercase, trim, collapse whitespace, strip control chars. Empty result is
// dropped silently by the caller.
function normalizeName(raw: string): string {
  let out = "";
  for (const ch of raw.toLowerCase()) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

function normalizeNames(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new ValidationError("tags must be an array of strings");
  }
  const out = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") {
      throw new ValidationError("tag entries must be strings");
    }
    const n = normalizeName(raw);
    if (n.length === 0) continue;
    if (n.length > MAX_NAME_LEN) {
      throw new ValidationError(`tag exceeds ${MAX_NAME_LEN} chars: ${n}`);
    }
    out.add(n);
  }
  if (out.size > MAX_TAGS_PER_ITEM) {
    throw new ValidationError(`no more than ${MAX_TAGS_PER_ITEM} tags per item`);
  }
  return [...out];
}

async function upsertTags(
  userId: string,
  names: string[],
): Promise<{ id: string; name: string }[]> {
  if (names.length === 0) return [];
  // SQLite has no native multi-row upsert and the count per call is small, so
  // do them one at a time inside the implicit autocommit.
  const tags: { id: string; name: string }[] = [];
  for (const name of names) {
    const tag = await db.tag.upsert({
      where: { userId_name: { userId, name } },
      create: { userId, name },
      update: {},
      select: { id: true, name: true },
    });
    tags.push(tag);
  }
  return tags;
}

export async function setCardTags(
  userId: string,
  cardId: string,
  rawNames: unknown,
): Promise<void> {
  const names = normalizeNames(rawNames);
  const card = await db.card.findFirst({
    where: { id: cardId, project: { userId } },
    select: { id: true },
  });
  if (!card) throw new NotFoundError("card not found");

  const tags = await upsertTags(userId, names);
  await db.$transaction([
    db.cardTag.deleteMany({ where: { cardId: card.id } }),
    ...(tags.length > 0
      ? [
          db.cardTag.createMany({
            data: tags.map((t) => ({ cardId: card.id, tagId: t.id })),
          }),
        ]
      : []),
  ]);
  emitBoard(userId);
}

export async function setIdeaTags(
  userId: string,
  ideaId: string,
  rawNames: unknown,
): Promise<void> {
  const names = normalizeNames(rawNames);
  const idea = await db.idea.findFirst({
    where: { id: ideaId, userId },
    select: { id: true },
  });
  if (!idea) throw new NotFoundError("idea not found");

  const tags = await upsertTags(userId, names);
  await db.$transaction([
    db.ideaTag.deleteMany({ where: { ideaId: idea.id } }),
    ...(tags.length > 0
      ? [
          db.ideaTag.createMany({
            data: tags.map((t) => ({ ideaId: idea.id, tagId: t.id })),
          }),
        ]
      : []),
  ]);
  emitBoard(userId);
}
