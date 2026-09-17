-- CreateTable
CREATE TABLE "ProjectClassLink" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,

    CONSTRAINT "ProjectClassLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectClassLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectClassLink_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ProjectClass" ("id") ON DELETE CASCADE ON UPDATE CASCADE,

    PRIMARY KEY ("projectId", "userId", "classId")
);

-- CreateIndex
CREATE INDEX "ProjectClassLink_userId_idx" ON "ProjectClassLink"("userId");

-- CreateIndex
CREATE INDEX "ProjectClassLink_classId_idx" ON "ProjectClassLink"("classId");

-- DataMigration: copy each owner's CLASS-mode project assignments into links
-- (userId = Project.userId, the owner) before scheduleMode/classId are
-- dropped below.
INSERT INTO "ProjectClassLink" ("projectId", "userId", "classId")
SELECT "id", "userId", "classId" FROM "Project" WHERE "scheduleMode" = 'CLASS' AND "classId" IS NOT NULL;

-- DataMigration: copy each shared viewer's CLASS-mode assignments into links
-- (userId = ProjectShare.sharedWithUserId, the viewer) before
-- scheduleMode/classId are dropped below.
INSERT INTO "ProjectClassLink" ("projectId", "userId", "classId")
SELECT "projectId", "sharedWithUserId", "classId" FROM "ProjectShare" WHERE "scheduleMode" = 'CLASS' AND "classId" IS NOT NULL;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "omnipresent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- DataMigration: omnipresent = (scheduleMode = 'ALWAYS'), read from the
-- original Project table immediately before it's dropped.
INSERT INTO "new_Project" ("id", "userId", "name", "priority", "archived", "omnipresent", "createdAt", "updatedAt")
SELECT "id", "userId", "name", "priority", "archived", ("scheduleMode" = 'ALWAYS'), "createdAt", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE INDEX "Project_userId_idx" ON "Project"("userId");
CREATE INDEX "Project_userId_priority_idx" ON "Project"("userId", "priority");
CREATE TABLE "new_ProjectShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sharedWithUserId" TEXT NOT NULL,
    "pinnedToBoard" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "omnipresent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectShare_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectShare_sharedWithUserId_fkey" FOREIGN KEY ("sharedWithUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- DataMigration: omnipresent = (scheduleMode = 'ALWAYS'), read from the
-- original ProjectShare table immediately before it's dropped.
INSERT INTO "new_ProjectShare" ("id", "projectId", "sharedWithUserId", "pinnedToBoard", "priority", "omnipresent", "createdAt")
SELECT "id", "projectId", "sharedWithUserId", "pinnedToBoard", "priority", ("scheduleMode" = 'ALWAYS'), "createdAt" FROM "ProjectShare";
DROP TABLE "ProjectShare";
ALTER TABLE "new_ProjectShare" RENAME TO "ProjectShare";
CREATE INDEX "ProjectShare_sharedWithUserId_idx" ON "ProjectShare"("sharedWithUserId");
CREATE INDEX "ProjectShare_projectId_idx" ON "ProjectShare"("projectId");
CREATE UNIQUE INDEX "ProjectShare_projectId_sharedWithUserId_key" ON "ProjectShare"("projectId", "sharedWithUserId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
