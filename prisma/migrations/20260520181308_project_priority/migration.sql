-- Project: replace `order` (manual drag-sort) with `priority` (manual override
-- for the activity-based sort). Backfill priority = order + 1 so existing
-- top-to-bottom rankings survive: top project becomes priority 1, next 2, etc.
-- After this, the algorithm sorts within each priority bucket.

PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_Project" ("id", "userId", "name", "priority", "archived", "createdAt", "updatedAt")
SELECT "id", "userId", "name", "order" + 1, "archived", "createdAt", "updatedAt"
FROM "Project";

DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";

CREATE INDEX "Project_userId_idx" ON "Project"("userId");
CREATE INDEX "Project_userId_priority_idx" ON "Project"("userId", "priority");

PRAGMA foreign_keys=ON;
