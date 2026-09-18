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
import * as axesLib from "@/lib/concepts/axes";
import * as componentsLib from "@/lib/concepts/components";
import * as decomp from "@/lib/concepts/decomposition";
import { resolveComponentByName } from "@/lib/concepts/resolve";
import { findOverlapPairs } from "@/lib/concepts/overlap";
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

function optionalInt(rec: Record<string, unknown>, key: string): number | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new ValidationError(`${key} must be an integer`);
  }
  return v;
}

function optionalEnum<T extends string>(
  rec: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !values.includes(v as T)) {
    throw new ValidationError(`${key} must be one of ${values.join(", ")}`);
  }
  return v as T;
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
    "List the user's projects (kanban board rows). Excludes archived unless requested. Each entry includes omnipresent (the built-in \"always active\" flag), classIds (schedule classes assigned to this project, any-of), and activeNow (whether the project's schedule currently marks it active — omnipresent || any assigned class is active right now; no classes and not omnipresent means out of mind) — see list_classes/set_project_schedule.",
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
    "List cards across all projects (summaries only — no body — but includes dueAt, expires, recurrence, seriesId, and doneAt). Filter by projectId, lane, and/or tag sets: tagsAny (OR), tagsAll (AND), tagsNot (exclude).",
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
      doneAt: card.doneAt ? card.doneAt.toISOString() : null,
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
  description: "Create a card in a project lane (not FAILED — that's reserved for the sweep). Optional body accepts a GFM-flavored markdown subset (headings, lists, task lists, blockquotes, code blocks, bold/italic/strike/code/link). Optionally set a due date and whether it expires (an overdue expiring card moves to the Failed lane within a minute). Optionally set a recurrence rule: when a card with a recurrence enters Done (or Failed), a fresh copy is created in To do with its next due date. `position` controls where in the lane it lands: \"top\" (default) or \"bottom\".",
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
      position: {
        type: "string",
        enum: ["top", "bottom"],
        description: "Where to insert within the lane. Default \"top\".",
      },
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
    const position = optionalEnum(rec, "position", ["top", "bottom"] as const);
    return boardM.createCard(ctx.userId, {
      projectId: requireString(rec, "projectId"),
      lane: requireLane(rec, "lane"),
      title: requireString(rec, "title", 200),
      contentJson: body ? markdownToTipTapJson(body) : null,
      ...(dueAt !== undefined ? { dueAt } : {}),
      ...(expires !== undefined ? { expires } : {}),
      ...(recurrence !== undefined ? { recurrence } : {}),
      ...(position !== undefined ? { position } : {}),
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
  description: "Move a card to a (possibly different) lane at the given index. Omit toIndex to place at the top. Idempotent. Rejects moving into or out of the Failed lane (use rescue_card to recover a failed card).",
  inputSchema: {
    type: "object",
    properties: {
      cardId: { type: "string" },
      toLane: { type: "string", enum: LANE_VALUES },
      toIndex: {
        type: "integer",
        minimum: 0,
        description: "Target index within the lane. Omit to place at the top.",
      },
    },
    required: ["cardId", "toLane"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const toIndex = optionalInt(rec, "toIndex");
    await boardM.moveCard(ctx.userId, {
      cardId: requireString(rec, "cardId"),
      toLane: requireLane(rec, "toLane"),
      ...(toIndex !== undefined ? { toIndex } : {}),
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
    "List ideas in the user's idea pool. Filter by tag sets: tagsAny (OR), tagsAll (AND), tagsNot (exclude). Each entry carries its decomposition in summary: `components` (the component names attached to it), `componentCount`, and `gapCount` (declared axes still empty). Use get_idea for the full per-axis breakdown.",
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
    // The pool decomposition is one fixed set of queries regardless of pool
    // size, so joining it on here is cheaper than a get_idea per row.
    const [ideas, pool] = await Promise.all([
      ideasQ.listIdeas(ctx.userId, { tagsAny, tagsAll, tagsNot }),
      decomp.getPoolDecomposition(ctx.userId),
    ]);
    const byId = new Map(pool.map((p) => [p.id, p]));
    return {
      ideas: ideas.map((idea) => {
        const p = byId.get(idea.id);
        return {
          ...idea,
          components: p ? p.axes.flatMap((a) => a.components.map((c) => c.name)) : [],
          componentCount: p?.componentCount ?? 0,
          gapCount: p?.gapCount ?? 0,
        };
      }),
    };
  },
};

const getIdea: Tool = {
  name: "get_idea",
  description:
    "Fetch a single idea with its full body. The body is returned as markdown-ish plain text. Also returns the concept's decomposition: `axes` are the dimensions this concept has been broken down along, each with the components filed under it. An axis with an empty `components` list is a declared gap — the user said this dimension applies and has not filled it in yet — which is a different thing from an axis that simply isn't listed. `undeclaredAxes` are the user's other axes, available to declare on this concept. `gapCount` counts the declared-but-empty ones. Each component carries `alsoUsedBy`, the other concepts sharing it, which is where connections between ideas show up.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const id = requireString(rec, "id");
    const [idea, decomposition] = await Promise.all([
      ideasQ.getIdea(ctx.userId, id),
      decomp.getConceptDecomposition(ctx.userId, id),
    ]);
    return {
      id: idea.id,
      order: idea.order,
      title: idea.title,
      body: tipTapJsonToMarkdown(idea.contentJson),
      tags: idea.tags,
      axes: decomposition.axes.map((a) => ({
        axisId: a.axisId,
        name: a.name,
        description: a.description,
        components: a.components.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          usageCount: c.usageCount,
          alsoUsedBy: c.alsoUsedBy,
        })),
      })),
      components: decomposition.axes.flatMap((a) => a.components.map((c) => c.name)),
      undeclaredAxes: decomposition.undeclaredAxes.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
      })),
      gapCount: decomposition.gapCount,
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
  description:
    "Convert an idea into a new project. If the idea has a body, it becomes a single Backlog card. The idea survives and is linked to the project it became. Requires at least one attached component: use add_component_to_concept to break the idea into its parts first, then promote. allowWithoutComponents exists for the cases where that genuinely doesn't apply, not as the normal route.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      allowWithoutComponents: {
        type: "boolean",
        description:
          "Promote an idea that has no components yet. The gate is there to make you look at what the idea is made of first, and add_component_to_concept is the way through it; set this only deliberately.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    return ideasM.promoteIdea(ctx.userId, requireString(rec, "id"), {
      allowWithoutComponents: optionalBool(rec, "allowWithoutComponents"),
    });
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
    "List the user's schedule classes (reusable named hour-of-week schedules used to mark a project active/inactive). Each entry includes a projectCount of how many of the user's project/share assignments (link rows) currently use it. The built-in \"Omnipresent\" flag lives directly on each project (see list_projects) and isn't a stored class.",
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
    "Delete a schedule class. Any of the user's project/share assignments (link rows) currently using it are removed; a project left with nothing selected (not omnipresent, no other classes) becomes out of mind.",
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
    "Set a project's schedule from your own point of view (mirrors set_project_priority: for a shared project this only changes your own view, not the owner's or other viewers'). `omnipresent` is the built-in \"always active\" flag; `classIds` is the full replacement set of schedule classes (you own) assigned to this project — the project is active if omnipresent OR any assigned class is currently active (any-of). Omit a field to leave it unchanged; passing `omnipresent: false, classIds: []` means out of mind (nothing selected).",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string" },
      omnipresent: { type: "boolean" },
      classIds: { type: "array", items: { type: "string" }, description: "Must be classes you own." },
    },
    required: ["projectId"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const projectId = requireString(rec, "projectId");
    const current = (await boardQ.listProjects(ctx.userId, { includeArchived: true })).find(
      (p) => p.id === projectId,
    );
    const omnipresent = typeof rec.omnipresent === "boolean" ? rec.omnipresent : (current?.omnipresent ?? true);
    const classIds = Array.isArray(rec.classIds)
      ? rec.classIds.filter((c): c is string => typeof c === "string")
      : (current?.classIds ?? []);
    await classesLib.setProjectSchedule(ctx.userId, projectId, { omnipresent, classIds });
    return { ok: true };
  },
};

// ---- concept decomposition ------------------------------------------------
//
// Axes are the dimensions an idea gets broken down along (Mechanic, Setting,
// Tone, Material); components are the reusable values filed under them. The
// point of the feature is that components are *referenced, not copied* — two
// concepts carrying "social deduction" carry the same row, which is the only
// reason overlap between ideas is computable at all. Near-duplicate names are
// what destroy that, so the write tools below push hard toward reuse.

const VOCABULARY_NOTE =
  "The component vocabulary is meant to stay small and heavily reused: the same component attached to several concepts is what makes overlap between ideas visible. Creating a second component that means what an existing one already means is a mistake, not a preference — it silently breaks the connection the feature exists to find. Search list_components before adding anything.";

const listAxesTool: Tool = {
  name: "list_axes",
  description:
    "List the user's axes — the dimensions concepts get decomposed along, such as Mechanic, Setting, or Tone. Axes belong to the user rather than to a kind of concept, so the same axis can sit on a game and on a story. Each entry includes componentCount (components filed under it) and conceptCount (concepts declaring it, declared gaps included).",
  inputSchema: EMPTY_OBJECT_SCHEMA,
  handler: async (ctx) => ({ axes: await axesLib.listAxes(ctx.userId) }),
};

const createAxisTool: Tool = {
  name: "create_axis",
  description:
    "Create an axis. Names are unique per user, case-insensitively — \"Mechanic\" and \"mechanic\" are the same axis. Axes are few and long-lived; before adding one, check list_axes for one that already covers the dimension you mean. The color is optional and derives from the name when omitted.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 40 },
      description: {
        type: ["string", "null"],
        description: "Short one-liner saying what this dimension is for.",
      },
      color: { type: ["string", "null"], description: "#rrggbb hex, or null to derive from the name." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    return axesLib.createAxis(ctx.userId, {
      name: requireString(rec, "name", 40),
      description: rec.description === null ? null : optionalString(rec, "description", 140),
      color: rec.color === null ? null : optionalString(rec, "color", 7),
    });
  },
};

const updateAxisTool: Tool = {
  name: "update_axis",
  description:
    "Update an axis's name, description, and/or color. Omit a field to leave it unchanged; pass null to clear description or color. Renaming an axis renames it everywhere it is declared.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string", maxLength: 40 },
      description: { type: ["string", "null"] },
      color: { type: ["string", "null"], description: "#rrggbb hex, or null to derive from the name." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    return axesLib.updateAxis(ctx.userId, requireString(rec, "id"), {
      name: optionalString(rec, "name", 40),
      ...("description" in rec
        ? { description: rec.description === null ? null : optionalString(rec, "description", 140) }
        : {}),
      ...("color" in rec ? { color: rec.color === null ? null : optionalString(rec, "color", 7) } : {}),
    });
  },
};

const deleteAxisTool: Tool = {
  name: "delete_axis",
  description:
    "DESTRUCTIVE — delete an axis, every component filed under it, and every attachment of those components to concepts. Check the componentCount and conceptCount from list_axes first; this is not a detach, the vocabulary goes with it.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    await axesLib.deleteAxis(ctx.userId, requireString(rec, "id"));
    return { deleted: true };
  },
};

const listComponentsTool: Tool = {
  name: "list_components",
  description:
    `List the user's component vocabulary, axis-major then name, optionally filtered to one axis. Includes components attached to nothing, since this list is the only place those can be seen. Each entry carries its description, usageCount, and usedBy (the concepts using it by name). ${VOCABULARY_NOTE}`,
  inputSchema: {
    type: "object",
    properties: {
      axisId: { type: "string", description: "Only components filed under this axis." },
    },
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const axisId = optionalString(rec, "axisId");
    const all = await componentsLib.listComponents(ctx.userId);
    return { components: axisId ? all.filter((c) => c.axisId === axisId) : all };
  },
};

const createComponentTool: Tool = {
  name: "create_component",
  description:
    `Add a component to the vocabulary without attaching it to anything. Usually the wrong tool: add_component_to_concept both finds-or-creates and attaches in one step, and attaching is what makes a component mean something. Reach for this only to seed vocabulary deliberately. ${VOCABULARY_NOTE} A name too close to one that already exists is refused; the error lists what it looked like, and confirmDespiteSimilar forces it through if they really are different things.`,
  inputSchema: {
    type: "object",
    properties: {
      axisId: { type: "string" },
      name: { type: "string", maxLength: 64, description: "Lowercased and whitespace-collapsed; vocabulary is lowercase." },
      description: { type: ["string", "null"], maxLength: 140 },
      confirmDespiteSimilar: {
        type: "boolean",
        description:
          "Create even though the name resembles an existing component. Set this only after reading the matches in the error and concluding they mean different things.",
      },
    },
    required: ["axisId", "name"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const resolved = await resolveComponentByName(ctx.userId, requireString(rec, "name", 64), {
      axisId: requireString(rec, "axisId"),
      description: rec.description === null ? null : optionalString(rec, "description", 140),
      create: true,
      confirmed: optionalBool(rec, "confirmDespiteSimilar"),
    });
    if (resolved.status === "needs-confirmation") throw nearDuplicateError(resolved.matches);
    if (resolved.status === "would-create") {
      throw new ValidationError("could not resolve a component for that name");
    }
    return {
      component: resolved.component,
      created: resolved.status === "created",
    };
  },
};

const updateComponentTool: Tool = {
  name: "update_component",
  description:
    "Update a component's name, description, and/or axis. The edit lands on every concept using it — that is the point of components being referenced rather than copied, so check usageCount from list_components before renaming one. Omit a field to leave it unchanged. Moving a component to another axis declares that axis on every concept already using it.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string", maxLength: 64 },
      description: { type: ["string", "null"], maxLength: 140 },
      axisId: { type: "string", description: "Move the component to a different axis." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    return componentsLib.updateComponent(ctx.userId, requireString(rec, "id"), {
      name: optionalString(rec, "name", 64),
      ...("description" in rec
        ? { description: rec.description === null ? null : optionalString(rec, "description", 140) }
        : {}),
      axisId: optionalString(rec, "axisId"),
    });
  },
};

const deleteComponentTool: Tool = {
  name: "delete_component",
  description:
    "DESTRUCTIVE — remove a component from the vocabulary entirely. It comes off every concept using it; check usageCount from list_components first. To take a component off one concept only, use remove_component_from_concept instead. Each affected concept keeps the axis, so a filled slot becomes a declared gap rather than the axis vanishing. Returns detachedFrom (how many concepts lost it) and restoredConcept — a demoted concept that was living as this component is returned to the idea pool rather than being stranded.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    return componentsLib.deleteComponent(ctx.userId, requireString(rec, "id"));
  },
};

/**
 * The near-duplicate refusal, as an error an MCP client can act on. The names
 * go in the message because the message is the only thing the caller reads.
 */
function nearDuplicateError(
  matches: { name: string; axisName: string; usageCount: number }[],
): ValidationError {
  const list = matches
    .map((m) => `"${m.name}" (axis ${m.axisName}, used by ${m.usageCount})`)
    .join(", ");
  return new ValidationError(
    `that name is close to component(s) you already have: ${list}. ` +
      "Attach one of those instead — reusing a component is what makes overlap between concepts visible. " +
      "If it genuinely means something different, retry with confirmDespiteSimilar: true.",
  );
}

const addComponentToConcept: Tool = {
  name: "add_component_to_concept",
  description:
    `Attach a component to a concept by name, creating it only if you say so. This is the main decomposition tool and the way through promote_idea's gate. ${VOCABULARY_NOTE} Resolution order: an exact name match attaches that existing component and creates nothing; a name that merely resembles existing ones is refused with those matches named, so you can attach one instead; only with create: true is new vocabulary minted, and even then a near-miss still blocks unless confirmDespiteSimilar is also set. axisId is required whenever a component might be created. Attaching also declares the component's axis on the concept if it wasn't already. Idempotent. Returns alsoUsedBy — the other concepts already carrying this component, which is the connection you were looking for.`,
  inputSchema: {
    type: "object",
    properties: {
      ideaId: { type: "string" },
      name: {
        type: "string",
        maxLength: 64,
        description: "Component name. The normal input; matched against the existing vocabulary first.",
      },
      componentId: {
        type: "string",
        description: "Attach a known component by id, skipping name resolution. Use name unless you already have the id from list_components.",
      },
      axisId: {
        type: "string",
        description: "Axis to file a newly created component under. Required when create is true.",
      },
      create: {
        type: "boolean",
        description: "Allow minting a new component when the name matches nothing. Default false, so an unrecognised name fails loudly rather than widening the vocabulary by accident.",
      },
      confirmDespiteSimilar: {
        type: "boolean",
        description: "Create even though the name resembles existing components. Only meaningful with create: true, and only after reading the matches in the error.",
      },
      description: {
        type: ["string", "null"],
        maxLength: 140,
        description: "Description for a newly created component. Ignored when an existing one is found.",
      },
    },
    required: ["ideaId"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const ideaId = requireString(rec, "ideaId");
    const componentId = optionalString(rec, "componentId");
    const name = optionalString(rec, "name", 64);

    // The id path is an escape hatch for callers that already did the lookup;
    // name-first is the default, because resolving by name is where reuse happens.
    if (componentId) {
      const result = await componentsLib.attachComponent(ctx.userId, ideaId, componentId);
      return {
        attached: true,
        created: false,
        component: {
          id: result.component.id,
          name: result.component.name,
          axisId: result.component.axisId,
          axisName: result.component.axisName,
        },
        alsoUsedBy: result.alsoUsedBy,
      };
    }

    if (name === undefined) {
      throw new ValidationError("name is required (or componentId, if you already have it)");
    }

    const resolved = await resolveComponentByName(ctx.userId, name, {
      axisId: optionalString(rec, "axisId"),
      description: rec.description === null ? null : optionalString(rec, "description", 140),
      create: optionalBool(rec, "create"),
      confirmed: optionalBool(rec, "confirmDespiteSimilar"),
    });

    if (resolved.status === "needs-confirmation") throw nearDuplicateError(resolved.matches);
    if (resolved.status === "would-create") {
      throw new ValidationError(
        `no component called "${resolved.name}" exists. ` +
          "Check list_components for one that already means this, or retry with create: true and an axisId to add it to the vocabulary.",
      );
    }

    const result = await componentsLib.attachComponent(
      ctx.userId,
      ideaId,
      resolved.component.id,
    );
    return {
      attached: true,
      created: resolved.status === "created",
      component: {
        id: result.component.id,
        name: result.component.name,
        axisId: result.component.axisId,
        axisName: result.component.axisName,
      },
      alsoUsedBy: result.alsoUsedBy,
    };
  },
};

const removeComponentFromConcept: Tool = {
  name: "remove_component_from_concept",
  description:
    "Detach a component from one concept. The component stays in the vocabulary and stays on every other concept using it — use delete_component to remove it everywhere. The concept keeps the axis, so the slot becomes a declared gap rather than disappearing.",
  inputSchema: {
    type: "object",
    properties: {
      ideaId: { type: "string" },
      componentId: { type: "string" },
    },
    required: ["ideaId", "componentId"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    await componentsLib.detachComponent(
      ctx.userId,
      requireString(rec, "ideaId"),
      requireString(rec, "componentId"),
    );
    return { detached: true };
  },
};

const declareConceptAxis: Tool = {
  name: "declare_concept_axis",
  description:
    "Declare an axis on a concept without filling it — an explicit \"this dimension applies here and I haven't decided yet\". Distinct from add_component_to_concept, which attaches an actual component (and declares the axis as a side effect). A declared empty axis shows up as a gap to fill; an axis that isn't declared reads as not applicable. Those are different statements and this is how you make the first one. Idempotent.",
  inputSchema: {
    type: "object",
    properties: {
      ideaId: { type: "string" },
      axisId: { type: "string" },
    },
    required: ["ideaId", "axisId"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    await componentsLib.addConceptAxis(
      ctx.userId,
      requireString(rec, "ideaId"),
      requireString(rec, "axisId"),
    );
    return { declared: true };
  },
};

const undeclareConceptAxis: Tool = {
  name: "undeclare_concept_axis",
  description:
    "Undeclare an axis on a concept — \"this dimension does not apply here\". Detaches every component filed under that axis from this concept, since a component cannot outlive its axis row on a concept; the components themselves survive in the vocabulary. Returns how many attachments went. The axis itself is untouched — use delete_axis to remove it from the user's set entirely.",
  inputSchema: {
    type: "object",
    properties: {
      ideaId: { type: "string" },
      axisId: { type: "string" },
    },
    required: ["ideaId", "axisId"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    return componentsLib.removeConceptAxis(
      ctx.userId,
      requireString(rec, "ideaId"),
      requireString(rec, "axisId"),
    );
  },
};

const findOverlappingConcepts: Tool = {
  name: "find_overlapping_concepts",
  description:
    "Find concepts that share components. Pass ideaId for one concept's partners; omit it to scan the whole pool. Deliberately not \"similar\" concepts: the useful pairs are not duplicates, they are an idea plus the pieces it was missing, so each result also names what the other side carries that this one lacks. A pair needs at least two shared components to appear — one is noise. Only concepts still in the pool are considered.",
  inputSchema: {
    type: "object",
    properties: {
      ideaId: {
        type: "string",
        description: "Limit to this concept's overlap partners. Omit to scan every pair in the pool.",
      },
    },
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const ideaId = optionalString(rec, "ideaId");
    if (ideaId) {
      return { partners: await decomp.getOverlapPartners(ctx.userId, ideaId) };
    }

    const pool = await decomp.getPoolDecomposition(ctx.userId);
    const names = new Map<string, string>();
    for (const concept of pool) {
      for (const axis of concept.axes) {
        for (const chip of axis.components) names.set(chip.id, chip.name);
      }
    }
    const label = (id: string) => names.get(id) ?? id;

    const pairs = findOverlapPairs(
      pool.map((c) => ({ id: c.id, title: c.title, componentIds: c.componentIds })),
    );
    return {
      pairs: pairs.map((p) => ({
        a: { id: p.a.id, title: p.a.title },
        b: { id: p.b.id, title: p.b.title },
        shared: p.shared,
        sharedNames: p.sharedIds.map(label).sort(),
        aOnlyNames: p.aOnlyIds.map(label).sort(),
        bOnlyNames: p.bOnlyIds.map(label).sort(),
      })),
    };
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
  listAxesTool,
  createAxisTool,
  updateAxisTool,
  deleteAxisTool,
  listComponentsTool,
  createComponentTool,
  updateComponentTool,
  deleteComponentTool,
  addComponentToConcept,
  removeComponentFromConcept,
  declareConceptAxis,
  undeclareConceptAxis,
  findOverlappingConcepts,
];

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}
