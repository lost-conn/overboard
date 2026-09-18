-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Idea" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "contentJson" TEXT,
    "contentMd" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "projectId" TEXT,
    "mirrorComponentId" TEXT,
    "demotedAt" DATETIME,
    CONSTRAINT "Idea_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Idea_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Idea_mirrorComponentId_fkey" FOREIGN KEY ("mirrorComponentId") REFERENCES "Component" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Idea" ("contentJson", "contentMd", "createdAt", "id", "order", "title", "updatedAt", "userId") SELECT "contentJson", "contentMd", "createdAt", "id", "order", "title", "updatedAt", "userId" FROM "Idea";
DROP TABLE "Idea";
ALTER TABLE "new_Idea" RENAME TO "Idea";
CREATE UNIQUE INDEX "Idea_projectId_key" ON "Idea"("projectId");
CREATE UNIQUE INDEX "Idea_mirrorComponentId_key" ON "Idea"("mirrorComponentId");
CREATE INDEX "Idea_userId_idx" ON "Idea"("userId");
CREATE INDEX "Idea_userId_order_idx" ON "Idea"("userId", "order");
CREATE INDEX "Idea_userId_demotedAt_idx" ON "Idea"("userId", "demotedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
