import "server-only";
import { db } from "@/lib/db";
import { ValidationError, NotFoundError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";
import { requireCardAccess, emitBoardForProject } from "@/lib/board/access";

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

export type RenameTagResult = {
  id: string;
  name: string;
  merged: boolean;
};

export async function renameTag(
  userId: string,
  tagId: string,
  rawNewName: unknown,
): Promise<RenameTagResult> {
  if (typeof rawNewName !== "string") {
    throw new ValidationError("new tag name must be a string");
  }
  const newName = normalizeName(rawNewName);
  if (newName.length === 0) {
    throw new ValidationError("tag name cannot be empty");
  }
  if (newName.length > MAX_NAME_LEN) {
    throw new ValidationError(`tag exceeds ${MAX_NAME_LEN} chars`);
  }

  const tag = await db.tag.findFirst({
    where: { id: tagId, userId },
    select: { id: true, name: true },
  });
  if (!tag) throw new NotFoundError("tag not found");
  if (tag.name === newName) {
    return { id: tag.id, name: tag.name, merged: false };
  }

  const existing = await db.tag.findFirst({
    where: { userId, name: newName, NOT: { id: tagId } },
    select: { id: true },
  });

  if (!existing) {
    await db.tag.update({ where: { id: tagId }, data: { name: newName } });
    emitBoard(userId);
    return { id: tagId, name: newName, merged: false };
  }

  // Merge: copy this tag's relations to the existing target, then delete this tag.
  // Cascade on Tag delete removes the old (cardId/ideaId, tagId) rows automatically.
  const cardLinks = await db.cardTag.findMany({
    where: { tagId },
    select: { cardId: true },
  });
  const ideaLinks = await db.ideaTag.findMany({
    where: { tagId },
    select: { ideaId: true },
  });

  const cardInserts = cardLinks.map((l) =>
    db.cardTag.upsert({
      where: { cardId_tagId: { cardId: l.cardId, tagId: existing.id } },
      create: { cardId: l.cardId, tagId: existing.id },
      update: {},
    }),
  );
  const ideaInserts = ideaLinks.map((l) =>
    db.ideaTag.upsert({
      where: { ideaId_tagId: { ideaId: l.ideaId, tagId: existing.id } },
      create: { ideaId: l.ideaId, tagId: existing.id },
      update: {},
    }),
  );

  await db.$transaction([
    ...cardInserts,
    ...ideaInserts,
    db.tag.delete({ where: { id: tagId } }),
  ]);
  emitBoard(userId);
  return { id: existing.id, name: newName, merged: true };
}

export async function setCardTags(
  userId: string,
  cardId: string,
  rawNames: unknown,
): Promise<void> {
  const names = normalizeNames(rawNames);
  const access = await requireCardAccess(userId, cardId);

  const tags = await upsertTags(access.ownerId, names);
  await db.$transaction([
    db.cardTag.deleteMany({ where: { cardId: access.cardId } }),
    ...(tags.length > 0
      ? [
          db.cardTag.createMany({
            data: tags.map((t) => ({ cardId: access.cardId, tagId: t.id })),
          }),
        ]
      : []),
  ]);
  await emitBoardForProject(access.projectId);
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
