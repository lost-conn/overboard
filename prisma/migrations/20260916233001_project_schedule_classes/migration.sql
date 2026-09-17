-- CreateTable
CREATE TABLE "ProjectClass" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tz" TEXT NOT NULL,
    "windows" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectClass_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "scheduleMode" TEXT NOT NULL DEFAULT 'ALWAYS',
    "classId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Project_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ProjectClass" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("archived", "createdAt", "id", "name", "priority", "updatedAt", "userId") SELECT "archived", "createdAt", "id", "name", "priority", "updatedAt", "userId" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE INDEX "Project_userId_idx" ON "Project"("userId");
CREATE INDEX "Project_userId_priority_idx" ON "Project"("userId", "priority");
CREATE INDEX "Project_classId_idx" ON "Project"("classId");
CREATE TABLE "new_ProjectShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sharedWithUserId" TEXT NOT NULL,
    "pinnedToBoard" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "scheduleMode" TEXT NOT NULL DEFAULT 'ALWAYS',
    "classId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectShare_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectShare_sharedWithUserId_fkey" FOREIGN KEY ("sharedWithUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectShare_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ProjectClass" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ProjectShare" ("createdAt", "id", "pinnedToBoard", "priority", "projectId", "sharedWithUserId") SELECT "createdAt", "id", "pinnedToBoard", "priority", "projectId", "sharedWithUserId" FROM "ProjectShare";
DROP TABLE "ProjectShare";
ALTER TABLE "new_ProjectShare" RENAME TO "ProjectShare";
CREATE INDEX "ProjectShare_sharedWithUserId_idx" ON "ProjectShare"("sharedWithUserId");
CREATE INDEX "ProjectShare_projectId_idx" ON "ProjectShare"("projectId");
CREATE INDEX "ProjectShare_classId_idx" ON "ProjectShare"("classId");
CREATE UNIQUE INDEX "ProjectShare_projectId_sharedWithUserId_key" ON "ProjectShare"("projectId", "sharedWithUserId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ProjectClass_userId_idx" ON "ProjectClass"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectClass_userId_name_key" ON "ProjectClass"("userId", "name");
