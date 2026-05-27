import "server-only";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";
import {
  requireProjectOwnership,
  requireCardAccess,
  getProjectParticipants,
  emitBoardForProject,
} from "./access";

export async function shareProject(
  userId: string,
  projectId: string,
  targetEmail: string,
): Promise<{ id: string; sharedWithUserId: string }> {
  await requireProjectOwnership(userId, projectId);

  const email = targetEmail.trim().toLowerCase();
  const targetUser = await db.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!targetUser) throw new ValidationError("no account found for that email");
  if (targetUser.id === userId) throw new ValidationError("cannot share with yourself");

  const share = await db.projectShare.upsert({
    where: {
      projectId_sharedWithUserId: { projectId, sharedWithUserId: targetUser.id },
    },
    create: { projectId, sharedWithUserId: targetUser.id },
    update: {},
    select: { id: true, sharedWithUserId: true },
  });

  publish(targetUser.id, { type: "board", at: new Date().toISOString() });
  return share;
}

export async function unshareProject(
  userId: string,
  projectId: string,
  targetUserId: string,
): Promise<void> {
  await requireProjectOwnership(userId, projectId);

  await db.projectShare.deleteMany({
    where: { projectId, sharedWithUserId: targetUserId },
  });

  publish(targetUserId, { type: "board", at: new Date().toISOString() });
}

export async function setPinnedToBoard(
  userId: string,
  projectId: string,
  pinned: boolean,
): Promise<void> {
  const share = await db.projectShare.findUnique({
    where: {
      projectId_sharedWithUserId: { projectId, sharedWithUserId: userId },
    },
  });
  if (!share) throw new NotFoundError("share not found");

  await db.projectShare.update({
    where: { id: share.id },
    data: { pinnedToBoard: pinned },
  });

  publish(userId, { type: "board", at: new Date().toISOString() });
}

export type ShareInfo = {
  userId: string;
  email: string;
  pinnedToBoard: boolean;
  createdAt: Date;
};

export async function listSharesForProject(
  userId: string,
  projectId: string,
): Promise<ShareInfo[]> {
  await requireProjectOwnership(userId, projectId);

  const shares = await db.projectShare.findMany({
    where: { projectId },
    include: { sharedWith: { select: { id: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  return shares.map((s) => ({
    userId: s.sharedWith.id,
    email: s.sharedWith.email,
    pinnedToBoard: s.pinnedToBoard,
    createdAt: s.createdAt,
  }));
}

export async function assignCard(
  userId: string,
  cardId: string,
  assigneeId: string | null,
): Promise<void> {
  const access = await requireCardAccess(userId, cardId);

  if (assigneeId) {
    const participants = await getProjectParticipants(access.projectId);
    if (!participants.includes(assigneeId)) {
      throw new ValidationError("assignee is not a project participant");
    }
  }

  await db.card.update({
    where: { id: access.cardId },
    data: { assigneeId },
  });

  await emitBoardForProject(access.projectId);
}

export type SharedProjectView = {
  shareId: string;
  projectId: string;
  projectName: string;
  ownerEmail: string;
  cardCount: number;
  pinnedToBoard: boolean;
  sharedAt: Date;
};

export async function getSharedProjects(
  userId: string,
): Promise<SharedProjectView[]> {
  const shares = await db.projectShare.findMany({
    where: { sharedWithUserId: userId },
    include: {
      project: {
        include: {
          user: { select: { email: true } },
          _count: { select: { cards: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return shares.map((s) => ({
    shareId: s.id,
    projectId: s.project.id,
    projectName: s.project.name,
    ownerEmail: s.project.user.email,
    cardCount: s.project._count.cards,
    pinnedToBoard: s.pinnedToBoard,
    sharedAt: s.createdAt,
  }));
}
