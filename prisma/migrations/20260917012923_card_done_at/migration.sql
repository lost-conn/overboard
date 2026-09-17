-- AlterTable
ALTER TABLE "Card" ADD COLUMN "doneAt" DATETIME;

-- Backfill: cards already sitting in DONE get doneAt set from their last update.
UPDATE "Card" SET "doneAt" = "updatedAt" WHERE "lane" = 'DONE' AND "doneAt" IS NULL;
