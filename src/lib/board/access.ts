import "server-only";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";

export type ProjectAccess = {
  projectId: string;
  ownerId: string;
  isOwner: boolean;
};

export async function resolveProjectAccess(
  userId: string,
  projectId: string,
): Promise<ProjectAccess | null> {
  const project = await db.project.findFirst({
    where: { id: projectId },
    select: { id: true, userId: true },
  });
  if (!project) return null;
  if (project.userId === userId) {
    return { projectId, ownerId: project.userId, isOwner: true };
  }
  const share = await db.projectShare.findUnique({
    where: { projectId_sharedWithUserId: { projectId, sharedWithUserId: userId } },
  });
  if (!share) return null;
  return { projectId, ownerId: project.userId, isOwner: false };
}

export async function requireProjectAccess(
  userId: string,
  projectId: string,
): Promise<ProjectAccess> {
  const access = await resolveProjectAccess(userId, projectId);
  if (!access) throw new NotFoundError("project not found");
  return access;
}

export async function requireProjectOwnership(
  userId: string,
  projectId: string,
): Promise<ProjectAccess> {
  const access = await resolveProjectAccess(userId, projectId);
  if (!access || !access.isOwner) throw new NotFoundError("project not found");
  return access;
}

export type CardAccess = {
  cardId: string;
  projectId: string;
  ownerId: string;
  isOwner: boolean;
};

export async function resolveCardAccess(
  userId: string,
  cardId: string,
): Promise<CardAccess | null> {
  const card = await db.card.findFirst({
    where: { id: cardId },
    select: { id: true, projectId: true, project: { select: { userId: true } } },
  });
  if (!card) return null;
  if (card.project.userId === userId) {
    return { cardId, projectId: card.projectId, ownerId: card.project.userId, isOwner: true };
  }
  const share = await db.projectShare.findUnique({
    where: {
      projectId_sharedWithUserId: {
        projectId: card.projectId,
        sharedWithUserId: userId,
      },
    },
  });
  if (!share) return null;
  return { cardId, projectId: card.projectId, ownerId: card.project.userId, isOwner: false };
}

export async function requireCardAccess(
  userId: string,
  cardId: string,
): Promise<CardAccess> {
  const access = await resolveCardAccess(userId, cardId);
  if (!access) throw new NotFoundError("card not found");
  return access;
}

export async function getProjectParticipants(projectId: string): Promise<string[]> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { userId: true, shares: { select: { sharedWithUserId: true } } },
  });
  if (!project) return [];
  return [project.userId, ...project.shares.map((s) => s.sharedWithUserId)];
}

export async function emitBoardForProject(projectId: string): Promise<void> {
  const participants = await getProjectParticipants(projectId);
  const event = { type: "board" as const, at: new Date().toISOString() };
  for (const uid of participants) {
    publish(uid, event);
  }
}
