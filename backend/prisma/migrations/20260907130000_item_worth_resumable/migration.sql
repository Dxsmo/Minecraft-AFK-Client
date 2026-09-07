-- Distinguish "paused because the bot went offline" (auto-resumes) from
-- "paused because the scan gave up" (needs an explicit restart).
ALTER TABLE "ItemWorthScan" ADD COLUMN "resumable" BOOLEAN NOT NULL DEFAULT true;
