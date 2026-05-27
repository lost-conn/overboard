-- CreateTable
CREATE TABLE "ProjectShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sharedWithUserId" TEXT NOT NULL,
    "pinnedToBoard" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectShare_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectShare_sharedWithUserId_fkey" FOREIGN KEY ("sharedWithUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Card" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "lane" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "contentJson" TEXT,
    "contentMd" TEXT,
    "assigneeId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Card_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Card_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Card" ("contentJson", "contentMd", "createdAt", "id", "lane", "order", "projectId", "title", "updatedAt") SELECT "contentJson", "contentMd", "createdAt", "id", "lane", "order", "projectId", "title", "updatedAt" FROM "Card";
DROP TABLE "Card";
ALTER TABLE "new_Card" RENAME TO "Card";
CREATE INDEX "Card_projectId_idx" ON "Card"("projectId");
CREATE INDEX "Card_projectId_lane_order_idx" ON "Card"("projectId", "lane", "order");
CREATE INDEX "Card_assigneeId_idx" ON "Card"("assigneeId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ProjectShare_sharedWithUserId_idx" ON "ProjectShare"("sharedWithUserId");

-- CreateIndex
CREATE INDEX "ProjectShare_projectId_idx" ON "ProjectShare"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectShare_projectId_sharedWithUserId_key" ON "ProjectShare"("projectId", "sharedWithUserId");
