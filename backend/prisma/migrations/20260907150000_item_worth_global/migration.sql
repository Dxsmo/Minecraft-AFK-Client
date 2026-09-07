-- Item worth becomes a single site-wide scan instead of a per-account one:
-- prices belong to the server, and the queries are spread round-robin over
-- several bots. The old per-account tables are dropped and rebuilt.

DROP TABLE IF EXISTS "ItemWorthValue";
DROP TABLE IF EXISTS "ItemWorthScan";

CREATE TABLE "ItemWorthScan" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "scanNumber" INTEGER NOT NULL DEFAULT 0,
    "changedCount" INTEGER NOT NULL DEFAULT 0,
    "missedCount" INTEGER NOT NULL DEFAULT 0,
    "resumable" BOOLEAN NOT NULL DEFAULT true,
    "delaySeconds" INTEGER NOT NULL DEFAULT 5,
    "accountIdsJson" TEXT NOT NULL DEFAULT '[]',
    "lastItemId" TEXT,
    "lastError" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "ItemWorthValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "value" REAL,
    "hasPrevious" BOOLEAN NOT NULL DEFAULT false,
    "previousValue" REAL,
    "scanNumber" INTEGER NOT NULL DEFAULT 0,
    "changedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "ItemWorthValue_itemId_key" ON "ItemWorthValue"("itemId");
CREATE INDEX "ItemWorthValue_changedAt_idx" ON "ItemWorthValue"("changedAt");
