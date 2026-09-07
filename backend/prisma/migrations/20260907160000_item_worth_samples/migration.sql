-- Diagnostics for unanswered /worth queries: keeps the chat lines that were
-- received but not recognised, so a wrong reply pattern is visible in the UI.
ALTER TABLE "ItemWorthScan" ADD COLUMN "lastSamplesJson" TEXT;
