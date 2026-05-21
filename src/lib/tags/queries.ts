import "server-only";
import { db } from "@/lib/db";
import { deriveTagColor } from "./color";

export type TagChip = { id: string; name: string; color: string };

type TagRow = { id: string; name: string; color: string | null };

export function toChip(row: TagRow): TagChip {
  return { id: row.id, name: row.name, color: row.color ?? deriveTagColor(row.name) };
}

export function joinToChips(rows: { tag: TagRow }[]): TagChip[] {
  return rows
    .map((r) => toChip(r.tag))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listTags(userId: string): Promise<TagChip[]> {
  const rows = await db.tag.findMany({
    where: { userId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, color: true },
  });
  return rows.map(toChip);
}
