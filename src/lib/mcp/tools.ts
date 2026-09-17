import "server-only";
import { db } from "@/lib/db";
import type { BearerContext } from "@/lib/tokens";
import { ValidationError } from "@/lib/errors";
import { Lane } from "@/generated/prisma/enums";
import * as boardQ from "@/lib/board/queries";
import * as boardM from "@/lib/board/mutations";
import * as sharing from "@/lib/board/sharing";
import * as classesLib from "@/lib/board/classes";
import * as ideasQ from "@/lib/ideas/queries";
import * as ideasM from "@/lib/ideas/mutations";
import * as tagsQ from "@/lib/tags/queries";
import * as tagsM from "@/lib/tags/mutations";
import { markdownToTipTapJson, tipTapJsonToMarkdown } from "./content";
import { parseRecurrence, type RecurrenceRule } from "@/lib/board/recurrence";

export type JsonSchema = Record<string, unknown>;

export type Tool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (ctx: BearerContext, args: unknown) => Promise<unknown>;
};

const EMPTY_OBJECT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const LANE_VALUES = Object.values(Lane) as string[];

// ---- arg helpers ---------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(rec: Record<string, unknown>, key: string, max = 1000): string {
  const v = rec[key];
  if (typeof v !== "string") throw new ValidationError(`${key} must be a string`);
  if (v.length > max) throw new ValidationError(`${key} too long`);
  return v;
}

function optionalString(
  rec: Record<string, unknown>,
  key: string,
  max = 20_000,
): string | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ValidationError(`${key} must be a string`);
  if (v.length > max) throw new ValidationError(`${key} too long`);
  return v;
}

function optionalBool(rec: Record<string, unknown>, key: string): boolean | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ValidationError(`${key} must be a boolean`);
  return v;
}

function requireInt(rec: Record<string, unknown>, key: string): number {
  const v = rec[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new ValidationError(`${key} must be an integer`);
  }
  return v;
}

function requireLane(rec: Record<string, unknown>, key: string): Lane {
  const v = rec[key];
  if (typeof v !== "string" || !LANE_VALUES.includes(v)) {
    throw new ValidationError(`${key} must be one of ${LANE_VALUES.join(", ")}`);
  }
  return v as Lane;
}

function optionalStringArray(rec: Record<string, unknown>, key: string): string[] | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new ValidationError(`${key} must be an array of strings`);
  for (const item of v) {
    if (typeof item !== "string") throw new ValidationError(`${key} must be an array of strings`);
  }
  return v as string[];
}

function requireStringArray(rec: Record<string, unknown>, key: string): string[] {
  const arr = optionalStringArray(rec, key);
  if (arr === undefined) throw new ValidationError(`${key} is required`);
  return arr;
}

// undefined = omitted (leave unchanged where relevant); null = explicit clear.
function optionalDate(rec: Record<string, unknown>, key: string): Date | null | undefined {
  const v = rec[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new ValidationError(`${key} must be an ISO 8601 string or null`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${key} is not a valid date`);
  return d;
}

function optionalLane(rec: Record<string, unknown>, key: string): Lane | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !LANE_VALUES.includes(v)) {
    throw new ValidationError(`${key} must be one of ${LANE_VALUES.join(", ")}`);
  }
  return v as Lane;
}

// undefined = omitted (leave unchanged); null = explicit clear. An object is
// validated as a recurrence rule; a missing tz defaults to "UTC" so callers
// that don't know the user's timezone can still create a rule.
function optionalRecurrenceInput(
  rec: Record<string, unknown>,
  key: string,
): RecurrenceRule | null | undefined {
  const v = rec[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new ValidationError(`${key} must be an object or null`);
  }
  return parseRecurrence({ tz: "UTC", ...(v as Record<string, unknown>) });
}

// Stored recurrence JSON should always be valid (it's validated on write),
// but if something ever gets in a bad state, degrade to null rather than
// failing the whole tool call.
function safeParseRecurrence(raw: string | null): RecurrenceRule | null {
  if (!raw) return null;
  try {
    return parseRecurrence(raw);
  } catch {
    return null;
  }
}

// ---- tool definitions ----------------------------------------------------

const whoami: Tool = {
  name: "whoami",
  description:
    "Returns the authenticated user's id, email, and the label of the token making the call.",
  inputSchema: EMPTY_OBJECT_SCHEMA,
  handler: async (ctx) => {
    const user = await db.user.findUnique({
      where: { id: ctx.userId },
      select: { id: true, email: true },
    });
    if (!user) throw new Error("user not found");
    return { userId: user.id, email: user.email, tokenLabel: ctx.tokenLabel };
  },
};

const listProjects: Tool = {
  name: "list_projects",
  description:
    "List the user's projects (kanban board rows). Excludes archived unless requested. Each entry includes scheduleMode (ALWAYS/NEVER/CLASS), classId (set when mode is CLASS), and activeNow (whether the project's schedule currently marks it active, evaluated at call time) — see list_classes/set_project_schedule.",
  inputSchema: {
    type: "object",
    properties: {
      includeArchived: {
        type: "boolean",
        description: "If true, include archived projects. Default false.",
      },
    },
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const includeArchived = optionalBool(rec, "includeArchived") ?? false;
    const projects = await boardQ.listProjects(ctx.userId, { includeArchived });
    return { projects };
  },
};

const createProject: Tool = {
  name: "create_project",
  description: "Create a new project (board row). Appended at the end.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", maxLength: 120 } },
    required: ["name"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    return boardM.createProject(ctx.userId, requireString(rec, "name", 120));
  },
};

const renameProject: Tool = {
  name: "rename_project",
  description: "Rename a project.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string", maxLength: 120 } },
    required: ["id", "name"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    return boardM.renameProject(ctx.userId, requireString(rec, "id"), requireString(rec, "name", 120));
  },
};

const setProjectPriority: Tool = {
  name: "set_project_priority",
  description:
    "Set a project's priority (lower = higher in the list). Default is 1. Use 0 or a negative number to pin to the top. The activity-based sort still orders projects within the same priority bucket.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      priority: { type: "integer", minimum: -99, maximum: 99 },
    },
    required: ["id", "priority"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    return boardM.setProjectPriority(
      ctx.userId,
      requireString(rec, "id"),
      requireInt(rec, "priority"),
    );
  },
};

const archiveProject: Tool = {
  name: "archive_project",
  description: "Archive (or unarchive) a project. Archived projects hide from the default board view but are not deleted.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      archived: { type: "boolean", description: "Defaults to true." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const archived = optionalBool(rec, "archived") ?? true;
    return boardM.setProjectArchived(ctx.userId, requireString(rec, "id"), archived);
  },
};

const deleteProject: Tool = {
  name: "delete_project",
  description: "DESTRUCTIVE — permanently delete a project and all its cards. Prefer archive_project unless you really mean it.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    await boardM.deleteProject(ctx.userId, requireString(rec, "id"));
    return { deleted: true };
  },
};

const listCards: Tool = {
  name: "list_cards",
  description:
    "List cards across all projects (summaries only — no body — but includes dueAt, expires, recurrence, and seriesId). Filter by projectId, lane, and/or tag sets: tagsAny (OR), tagsAll (AND), tagsNot (exclude).",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string" },
      lane: { type: "string", enum: LANE_VALUES },
      tagsAny: {
        type: "array",
        items: { type: "string" },
        description: "Match cards having any of these tag names (OR).",
      },
      tagsAll: {
        type: "array",
        items: { type: "string" },
        description: "Match cards having every one of these tag names (AND).",
      },
      tagsNot: {
        type: "array",
        items: { type: "string" },
        description: "Exclude cards having any of these tag names.",
      },
    },
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const projectId = optionalString(rec, "projectId");
    const lane = optionalLane(rec, "lane");
    const tagsAny = optionalStringArray(rec, "tagsAny");
    const tagsAll = optionalStringArray(rec, "tagsAll");
    const tagsNot = optionalStringArray(rec, "tagsNot");
    const cards = await boardQ.listCards(ctx.userId, {
      projectId,
      lane,
      tagsAny,
      tagsAll,
      tagsNot,
    });
    return {
      cards: cards.map((c) => ({ ...c, recurrence: safeParseRecurrence(c.recurrence) })),
    };
  },
};

const getCard: Tool = {
  name: "get_card",
  description: "Fetch a single card with its full body. The body is returned as markdown-ish plain text.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const card = await boardQ.getCard(ctx.userId, requireString(rec, "id"));
    return {
      id: card.id,
      projectId: card.projectId,
      lane: card.lane,
      order: card.order,
      title: card.title,
      body: tipTapJsonToMarkdown(card.contentJson),
      tags: card.tags,
      assignee: card.assignee ?? null,
      dueAt: card.dueAt ? card.dueAt.toISOString() : null,
      expires: card.expires,
      failedAt: card.failedAt ? card.failedAt.toISOString() : null,
      rescuedAt: card.rescuedAt ? card.rescuedAt.toISOString() : null,
      recurrence: safeParseRecurrence(card.recurrence),
      seriesId: card.seriesId,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    };
  },
};

const RECURRENCE_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "A repeat rule for this card. Shape: { freq: \"daily\"|\"weekly\"|\"monthly\", interval: integer >= 1, byWeekday?: number[] (0=Sun..6=Sat, weekly only), byMonthDay?: integer 1-31 (monthly only), anchor: \"schedule\"|\"completion\", tz: IANA timezone string }. anchor \"schedule\" computes the next occurrence from the fixed schedule (missed periods are skipped forward to the first one after now); anchor \"completion\" computes it as now + interval, preserving the card's previous due time-of-day. tz may be omitted, in which case it defaults to \"UTC\".",
  properties: {
    freq: { type: "string", enum: ["daily", "weekly", "monthly"] },
    interval: { type: "integer", minimum: 1 },
    byWeekday: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
    byMonthDay: { type: "integer", minimum: 1, maximum: 31 },
    anchor: { type: "string", enum: ["schedule", "completion"] },
    tz: { type: "string", description: "IANA timezone, e.g. \"America/Chicago\". Defaults to \"UTC\" if omitted." },
  },
  required: ["freq", "interval", "anchor"],
  additionalProperties: false,
};

const createCard: Tool = {
  name: "create_card",
  description: "Create a card in a project lane (not FAILED — that's reserved for the sweep). Optional body accepts a GFM-flavored markdown subset (headings, lists, task lists, blockquotes, code blocks, bold/italic/strike/code/link). Optionally set a due date and whether it expires (an overdue expiring card moves to the Failed lane within a minute). Optionally set a recurrence rule: when a card with a recurrence enters Done (or Failed), a fresh copy is created in To do with its next due date.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string" },
      lane: { type: "string", enum: LANE_VALUES },
      title: { type: "string", maxLength: 200 },
      body: { type: "string", description: "Optional markdown body." },
      dueAt: {
        type: ["string", "null"],
        description: "ISO 8601 due date/time, or null for no due date.",
      },
      expires: {
        type: "boolean",
        description: "If true, the card moves to the Failed lane within a minute of its due date passing. Default false.",
      },
      recurrence: RECURRENCE_SCHEMA,
    },
    required: ["projectId", "lane", "title"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const body = optionalString(rec, "body");
    const dueAt = optionalDate(rec, "dueAt");
    const expires = optionalBool(rec, "expires");
    const recurrence = optionalRecurrenceInput(rec, "recurrence");
    return boardM.createCard(ctx.userId, {
      projectId: requireString(rec, "projectId"),
      lane: requireLane(rec, "lane"),
      title: requireString(rec, "title", 200),
      contentJson: body ? markdownToTipTapJson(body) : null,
      ...(dueAt !== undefined ? { dueAt } : {}),
      ...(expires !== undefined ? { expires } : {}),
      ...(recurrence !== undefined ? { recurrence } : {}),
    });
  },
};

const updateCard: Tool = {
  name: "update_card",
  description: "Update a card's title and/or body. Omit body to leave it unchanged. Pass body=\"\" to clear. Body accepts a GFM-flavored markdown subset (headings, lists, task lists, blockquotes, code blocks, bold/italic/strike/code/link). Omit dueAt/expires to leave them unchanged; pass dueAt=null to clear the due date. Omit recurrence to leave it unchanged; pass recurrence=null to clear it. Can't move a card to/from the Failed lane this way.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string", maxLength: 200 },
      body: { type: "string", description: "If provided, replaces the card body. Empty string clears." },
      dueAt: {
        type: ["string", "null"],
        description: "ISO 8601 due date/time, or null to clear. Omit to leave unchanged.",
      },
      expires: {
        type: "boolean",
        description: "If true, the card moves to the Failed lane within a minute of its due date passing. Omit to leave unchanged.",
      },
      recurrence: {
        ...RECURRENCE_SCHEMA,
        type: ["object", "null"],
        description: `${RECURRENCE_SCHEMA.description} Pass null to clear the recurrence. Omit to leave unchanged.`,
      },
    },
    required: ["id", "title"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const body = optionalString(rec, "body");
    const dueAt = optionalDate(rec, "dueAt");
    const expires = optionalBool(rec, "expires");
    const recurrence = optionalRecurrenceInput(rec, "recurrence");
    return boardM.updateCard(ctx.userId, {
      id: requireString(rec, "id"),
      title: requireString(rec, "title", 200),
      ...(body === undefined
        ? {}
        : body === ""
          ? { contentJson: null }
          : { contentJson: markdownToTipTapJson(body) }),
      ...(dueAt !== undefined ? { dueAt } : {}),
      ...(expires !== undefined ? { expires } : {}),
      ...(recurrence !== undefined ? { recurrence } : {}),
    });
  },
};

const moveCard: Tool = {
  name: "move_card",
  description: "Move a card to a (possibly different) lane at the given index. Idempotent. Rejects moving into or out of the Failed lane (use rescue_card to recover a failed card).",
  inputSchema: {
    type: "object",
    properties: {
      cardId: { type: "string" },
      toLane: { type: "string", enum: LANE_VALUES },
      toIndex: { type: "integer", minimum: 0 },
    },
    required: ["cardId", "toLane", "toIndex"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    await boardM.moveCard(ctx.userId, {
      cardId: requireString(rec, "cardId"),
      toLane: requireLane(rec, "toLane"),
      toIndex: requireInt(rec, "toIndex"),
    });
    return { moved: true };
  },
};

const deleteCard: Tool = {
  name: "delete_card",
  description: "DESTRUCTIVE — permanently delete a card.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    await boardM.deleteCard(ctx.userId, requireString(rec, "id"));
    return { deleted: true };
  },
};

const rescueCard: Tool = {
  name: "rescue_card",
  description:
    "Rescue a card out of the Failed lane back into Done. Fails if the card isn't currently in the Failed lane.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    await boardM.rescueCard(ctx.userId, requireString(rec, "id"));
    return { rescued: true };
  },
};

const listIdeas: Tool = {
  name: "list_ideas",
  description:
    "List ideas in the user's idea pool. Filter by tag sets: tagsAny (OR), tagsAll (AND), tagsNot (exclude).",
  inputSchema: {
    type: "object",
    properties: {
      tagsAny: {
        type: "array",
        items: { type: "string" },
        description: "Match ideas having any of these tag names (OR).",
      },
      tagsAll: {
        type: "array",
        items: { type: "string" },
        description: "Match ideas having every one of these tag names (AND).",
      },
      tagsNot: {
        type: "array",
        items: { type: "string" },
        description: "Exclude ideas having any of these tag names.",
      },
    },
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const tagsAny = optionalStringArray(rec, "tagsAny");
    const tagsAll = optionalStringArray(rec, "tagsAll");
    const tagsNot = optionalStringArray(rec, "tagsNot");
    return {
      ideas: await ideasQ.listIdeas(ctx.userId, { tagsAny, tagsAll, tagsNot }),
    };
  },
};

const getIdea: Tool = {
  name: "get_idea",
  description: "Fetch a single idea with its full body. The body is returned as markdown-ish plain text.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const idea = await ideasQ.getIdea(ctx.userId, requireString(rec, "id"));
    return {
      id: idea.id,
      order: idea.order,
      title: idea.title,
      body: tipTapJsonToMarkdown(idea.contentJson),
      tags: idea.tags,
      createdAt: idea.createdAt,
      updatedAt: idea.updatedAt,
    };
  },
};

const createIdea: Tool = {
  name: "create_idea",
  description: "Add an idea to the idea pool.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 200 },
      body: { type: "string" },
    },
    required: ["title"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const body = optionalString(rec, "body");
    return ideasM.createIdea(ctx.userId, requireString(rec, "title", 200), {
      contentJson: body ? markdownToTipTapJson(body) : null,
    });
  },
};

const updateIdea: Tool = {
  name: "update_idea",
  description: "Update an idea's title and/or body. Omit a field to leave unchanged. Pass body=\"\" to clear.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string", maxLength: 200 },
      body: { type: "string" },
    },
    required: ["id", "title"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const body = optionalString(rec, "body");
    return ideasM.updateIdea(ctx.userId, {
      id: requireString(rec, "id"),
      title: requireString(rec, "title", 200),
      ...(body === undefined
        ? {}
        : body === ""
          ? { contentJson: null }
          : { contentJson: markdownToTipTapJson(body) }),
    });
  },
};

const deleteIdea: Tool = {
  name: "delete_idea",
  description: "DESTRUCTIVE — permanently delete an idea.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    await ideasM.deleteIdea(ctx.userId, requireString(rec, "id"));
    return { deleted: true };
  },
};

const listTags: Tool = {
  name: "list_tags",
  description: "List the user's tags with their (possibly auto-derived) colors.",
  inputSchema: EMPTY_OBJECT_SCHEMA,
  handler: async (ctx) => ({ tags: await tagsQ.listTags(ctx.userId) }),
};

const renameTag: Tool = {
  name: "rename_tag",
  description:
    "Rename a tag. The new name applies to every card and idea that uses it. If a tag with the new name already exists, the two are merged into the existing target (their relations are unioned, and the renamed tag is deleted).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string", maxLength: 32 },
    },
    required: ["id", "name"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    return tagsM.renameTag(ctx.userId, requireString(rec, "id"), requireString(rec, "name", 32));
  },
};

const setCardTags: Tool = {
  name: "set_card_tags",
  description: "Replace the tag set on a card. Pass an empty array to clear. New tag names are created on first use; names are lowercased and trimmed.",
  inputSchema: {
    type: "object",
    properties: {
      cardId: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["cardId", "tags"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    await tagsM.setCardTags(ctx.userId, requireString(rec, "cardId"), requireStringArray(rec, "tags"));
    return { ok: true };
  },
};

const setIdeaTags: Tool = {
  name: "set_idea_tags",
  description: "Replace the tag set on an idea. Pass an empty array to clear. New tag names are created on first use; names are lowercased and trimmed.",
  inputSchema: {
    type: "object",
    properties: {
      ideaId: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["ideaId", "tags"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    await tagsM.setIdeaTags(ctx.userId, requireString(rec, "ideaId"), requireStringArray(rec, "tags"));
    return { ok: true };
  },
};

const promoteIdea: Tool = {
  name: "promote_idea",
  description: "Convert an idea into a new project. If the idea has a body, it becomes a single Backlog card. The idea is deleted on success.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    return ideasM.promoteIdea(ctx.userId, requireString(rec, "id"));
  },
};

const shareProject: Tool = {
  name: "share_project",
  description: "Share a project with another user by email. Only the project owner can share.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string" },
      email: { type: "string", description: "Email of the user to share with. Must be an existing account." },
    },
    required: ["projectId", "email"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    return sharing.shareProject(ctx.userId, requireString(rec, "projectId"), requireString(rec, "email"));
  },
};

const unshareProject: Tool = {
  name: "unshare_project",
  description: "Remove a user's access to a shared project. Only the owner can unshare.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string" },
      userId: { type: "string", description: "ID of the user to remove." },
    },
    required: ["projectId", "userId"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    await sharing.unshareProject(ctx.userId, requireString(rec, "projectId"), requireString(rec, "userId"));
    return { ok: true };
  },
};

const listProjectShares: Tool = {
  name: "list_project_shares",
  description: "List users a project is shared with. Only the owner can view shares.",
  inputSchema: {
    type: "object",
    properties: { projectId: { type: "string" } },
    required: ["projectId"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const shares = await sharing.listSharesForProject(ctx.userId, requireString(rec, "projectId"));
    return { shares };
  },
};

const setPinnedToBoard: Tool = {
  name: "set_pinned_to_board",
  description: "Pin or unpin a shared project to/from your main board.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string" },
      pinned: { type: "boolean" },
    },
    required: ["projectId", "pinned"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const pinned = optionalBool(rec, "pinned") ?? true;
    await sharing.setPinnedToBoard(ctx.userId, requireString(rec, "projectId"), pinned);
    return { ok: true };
  },
};

const assignCard: Tool = {
  name: "assign_card",
  description: "Assign a card to a project participant, or clear assignment. Pass null to unassign.",
  inputSchema: {
    type: "object",
    properties: {
      cardId: { type: "string" },
      assigneeId: { type: ["string", "null"], description: "User ID to assign, or null to unassign." },
    },
    required: ["cardId", "assigneeId"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const assigneeId = rec.assigneeId === null ? null : requireString(rec, "assigneeId");
    await sharing.assignCard(ctx.userId, requireString(rec, "cardId"), assigneeId);
    return { ok: true };
  },
};

const WINDOW_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "A recurring hour range within a class. Weekly: { kind: \"weekly\", weekdays: number[] (0=Sun..6=Sat, non-empty, no duplicates), startHour: integer 0-23, endHour: integer 1-24 }. Monthly: { kind: \"monthly\", ordinal: 1|2|3|4|-1 (the nth occurrence of `weekday` in the month; -1 = last), weekday: integer 0-6, startHour: integer 0-23, endHour: integer 1-24 }. When startHour > endHour the window wraps past midnight (e.g. startHour 22, endHour 2 covers 22:00 through 02:00 the next day). endHour 24 means \"through the end of the day\".",
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "weekly" },
        weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
        startHour: { type: "integer", minimum: 0, maximum: 23 },
        endHour: { type: "integer", minimum: 1, maximum: 24 },
      },
      required: ["kind", "weekdays", "startHour", "endHour"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "monthly" },
        ordinal: { type: "integer", enum: [1, 2, 3, 4, -1] },
        weekday: { type: "integer", minimum: 0, maximum: 6 },
        startHour: { type: "integer", minimum: 0, maximum: 23 },
        endHour: { type: "integer", minimum: 1, maximum: 24 },
      },
      required: ["kind", "ordinal", "weekday", "startHour", "endHour"],
      additionalProperties: false,
    },
  ],
};

const listClassesTool: Tool = {
  name: "list_classes",
  description:
    "List the user's schedule classes (reusable named hour-of-week schedules used to mark a project active/inactive). Each entry includes a projectCount of how many of the user's projects/shares currently use it. Built-in ALWAYS/NEVER modes are virtual and not listed here — only CLASS-mode schedules are stored classes.",
  inputSchema: EMPTY_OBJECT_SCHEMA,
  handler: async (ctx) => ({ classes: await classesLib.listClasses(ctx.userId) }),
};

const createClassTool: Tool = {
  name: "create_class",
  description:
    "Create a reusable schedule class. `windows` is an array of hour ranges (see schema); the class is active whenever now falls inside any window, evaluated in `tz`. `tz` defaults to \"UTC\" if omitted.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 60 },
      tz: { type: "string", description: "IANA timezone, e.g. \"America/Chicago\". Defaults to \"UTC\" if omitted." },
      windows: { type: "array", items: WINDOW_SCHEMA },
    },
    required: ["name", "windows"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const tz = optionalString(rec, "tz") ?? "UTC";
    return classesLib.createClass(ctx.userId, {
      name: requireString(rec, "name", 60),
      tz,
      windows: rec.windows,
    });
  },
};

const updateClassTool: Tool = {
  name: "update_class",
  description: "Update a schedule class's name, timezone, and/or windows. Omit a field to leave it unchanged.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string", maxLength: 60 },
      tz: { type: "string", description: "IANA timezone, e.g. \"America/Chicago\"." },
      windows: { type: "array", items: WINDOW_SCHEMA },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    return classesLib.updateClass(ctx.userId, requireString(rec, "id"), {
      name: optionalString(rec, "name", 60),
      tz: optionalString(rec, "tz"),
      windows: rec.windows === undefined ? undefined : rec.windows,
    });
  },
};

const deleteClassTool: Tool = {
  name: "delete_class",
  description:
    "Delete a schedule class. Any of the user's projects/shares currently assigned to it revert to ALWAYS (mode) with no class first.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    await classesLib.deleteClass(ctx.userId, requireString(rec, "id"));
    return { deleted: true };
  },
};

const setProjectSchedule: Tool = {
  name: "set_project_schedule",
  description:
    "Set a project's schedule mode from your own point of view (mirrors set_project_priority: for a shared project this only changes your own view, not the owner's or other viewers'). mode is one of ALWAYS (\"Omnipresent\", always active), NEVER (\"Out of mind\", never active), or CLASS (active per a schedule class you own — classId is required in that case).",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string" },
      mode: { type: "string", enum: ["ALWAYS", "NEVER", "CLASS"] },
      classId: { type: "string", description: "Required when mode is CLASS. Must be a class you own." },
    },
    required: ["projectId", "mode"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    await classesLib.setProjectSchedule(ctx.userId, requireString(rec, "projectId"), {
      mode: requireString(rec, "mode"),
      classId: optionalString(rec, "classId"),
    });
    return { ok: true };
  },
};

export const TOOLS: Tool[] = [
  whoami,
  listProjects,
  createProject,
  renameProject,
  setProjectPriority,
  archiveProject,
  deleteProject,
  listCards,
  getCard,
  createCard,
  updateCard,
  moveCard,
  deleteCard,
  rescueCard,
  listIdeas,
  getIdea,
  createIdea,
  updateIdea,
  deleteIdea,
  promoteIdea,
  listTags,
  renameTag,
  setCardTags,
  setIdeaTags,
  shareProject,
  unshareProject,
  listProjectShares,
  setPinnedToBoard,
  assignCard,
  listClassesTool,
  createClassTool,
  updateClassTool,
  deleteClassTool,
  setProjectSchedule,
];

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}
