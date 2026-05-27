-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ProjectShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sharedWithUserId" TEXT NOT NULL,
    "pinnedToBoard" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectShare_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectShare_sharedWithUserId_fkey" FOREIGN KEY ("sharedWithUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ProjectShare" ("createdAt", "id", "pinnedToBoard", "projectId", "sharedWithUserId") SELECT "createdAt", "id", "pinnedToBoard", "projectId", "sharedWithUserId" FROM "ProjectShare";
DROP TABLE "ProjectShare";
ALTER TABLE "new_ProjectShare" RENAME TO "ProjectShare";
CREATE INDEX "ProjectShare_sharedWithUserId_idx" ON "ProjectShare"("sharedWithUserId");
CREATE INDEX "ProjectShare_projectId_idx" ON "ProjectShare"("projectId");
CREATE UNIQUE INDEX "ProjectShare_projectId_sharedWithUserId_key" ON "ProjectShare"("projectId", "sharedWithUserId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
