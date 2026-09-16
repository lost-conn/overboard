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
    "dueAt" DATETIME,
    "expires" BOOLEAN NOT NULL DEFAULT false,
    "failedAt" DATETIME,
    "rescuedAt" DATETIME,
    "recurrence" TEXT,
    "seriesId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Card_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Card_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Card" ("assigneeId", "contentJson", "contentMd", "createdAt", "id", "lane", "order", "projectId", "title", "updatedAt") SELECT "assigneeId", "contentJson", "contentMd", "createdAt", "id", "lane", "order", "projectId", "title", "updatedAt" FROM "Card";
DROP TABLE "Card";
ALTER TABLE "new_Card" RENAME TO "Card";
CREATE INDEX "Card_projectId_idx" ON "Card"("projectId");
CREATE INDEX "Card_projectId_lane_order_idx" ON "Card"("projectId", "lane", "order");
CREATE INDEX "Card_assigneeId_idx" ON "Card"("assigneeId");
CREATE INDEX "Card_dueAt_idx" ON "Card"("dueAt");
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failedWindowDays" INTEGER NOT NULL DEFAULT 7
);
INSERT INTO "new_User" ("createdAt", "email", "id", "passwordHash") SELECT "createdAt", "email", "id", "passwordHash" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
