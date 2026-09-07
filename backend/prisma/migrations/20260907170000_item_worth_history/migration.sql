-- Archive of every /worth scan, so past price lists stay available after a
-- newer scan overwrites the live values.
ALTER TABLE "ItemWorthScan" ADD COLUMN "runId" TEXT;

CREATE TABLE "ItemWorthRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "delaySeconds" INTEGER NOT NULL DEFAULT 5,
    "accountIdsJson" TEXT NOT NULL DEFAULT '[]',
    "changedCount" INTEGER NOT NULL DEFAULT 0,
    "missedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);
CREATE UNIQUE INDEX "ItemWorthRun_scanNumber_key" ON "ItemWorthRun"("scanNumber");
CREATE INDEX "ItemWorthRun_scanNumber_idx" ON "ItemWorthRun"("scanNumber");

CREATE TABLE "ItemWorthRunValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "value" REAL,
    "previousValue" REAL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ItemWorthRunValue_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ItemWorthRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ItemWorthRunValue_runId_itemId_key" ON "ItemWorthRunValue"("runId", "itemId");
CREATE INDEX "ItemWorthRunValue_runId_recordedAt_idx" ON "ItemWorthRunValue"("runId", "recordedAt");
