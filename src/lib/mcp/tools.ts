import "server-only";
import { db } from "@/lib/db";
import type { BearerContext } from "@/lib/tokens";
import { ValidationError } from "@/lib/errors";
import { Lane } from "@/generated/prisma/enums";
import * as boardQ from "@/lib/board/queries";
import * as boardM from "@/lib/board/mutations";
import * as ideasQ from "@/lib/ideas/queries";
import * as ideasM from "@/lib/ideas/mutations";
import * as tagsQ from "@/lib/tags/queries";
import * as tagsM from "@/lib/tags/mutations";
import { markdownToTipTapJson, tipTapJsonToMarkdown } from "./content";

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

function optionalLane(rec: Record<string, unknown>, key: string): Lane | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !LANE_VALUES.includes(v)) {
    throw new ValidationError(`${key} must be one of ${LANE_VALUES.join(", ")}`);
  }
  return v as Lane;
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
  description: "List the user's projects (kanban board rows). Excludes archived unless requested.",
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
    "List cards across all projects (summaries only — no body). Filter by projectId, lane, and/or tag sets: tagsAny (OR), tagsAll (AND), tagsNot (exclude).",
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
    return { cards };
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
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    };
  },
};

const createCard: Tool = {
  name: "create_card",
  description: "Create a card in a project lane. Optional body accepts a GFM-flavored markdown subset (headings, lists, task lists, blockquotes, code blocks, bold/italic/strike/code/link).",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string" },
      lane: { type: "string", enum: LANE_VALUES },
      title: { type: "string", maxLength: 200 },
      body: { type: "string", description: "Optional markdown body." },
    },
    required: ["projectId", "lane", "title"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const body = optionalString(rec, "body");
    return boardM.createCard(ctx.userId, {
      projectId: requireString(rec, "projectId"),
      lane: requireLane(rec, "lane"),
      title: requireString(rec, "title", 200),
      contentJson: body ? markdownToTipTapJson(body) : null,
    });
  },
};

const updateCard: Tool = {
  name: "update_card",
  description: "Update a card's title and/or body. Omit body to leave it unchanged. Pass body=\"\" to clear. Body accepts a GFM-flavored markdown subset (headings, lists, task lists, blockquotes, code blocks, bold/italic/strike/code/link).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string", maxLength: 200 },
      body: { type: "string", description: "If provided, replaces the card body. Empty string clears." },
    },
    required: ["id", "title"],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const rec = asRecord(args);
    const body = optionalString(rec, "body");
    return boardM.updateCard(ctx.userId, {
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

const moveCard: Tool = {
  name: "move_card",
  description: "Move a card to a (possibly different) lane at the given index. Idempotent.",
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
  listIdeas,
  createIdea,
  updateIdea,
  deleteIdea,
  promoteIdea,
  listTags,
  setCardTags,
  setIdeaTags,
];

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}
