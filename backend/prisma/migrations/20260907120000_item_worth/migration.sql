-- Item worth scanning: per-account scan progress plus the scanned prices.

CREATE TABLE "ItemWorthScan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "minecraftAccountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "scanNumber" INTEGER NOT NULL DEFAULT 0,
    "changedCount" INTEGER NOT NULL DEFAULT 0,
    "missedCount" INTEGER NOT NULL DEFAULT 0,
    "lastItemId" TEXT,
    "lastError" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ItemWorthScan_minecraftAccountId_fkey" FOREIGN KEY ("minecraftAccountId") REFERENCES "MinecraftAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ItemWorthScan_minecraftAccountId_key" ON "ItemWorthScan"("minecraftAccountId");

CREATE TABLE "ItemWorthValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "minecraftAccountId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "value" REAL,
    "hasPrevious" BOOLEAN NOT NULL DEFAULT false,
    "previousValue" REAL,
    "scanNumber" INTEGER NOT NULL DEFAULT 0,
    "changedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ItemWorthValue_minecraftAccountId_fkey" FOREIGN KEY ("minecraftAccountId") REFERENCES "MinecraftAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ItemWorthValue_minecraftAccountId_itemId_key" ON "ItemWorthValue"("minecraftAccountId", "itemId");
CREATE INDEX "ItemWorthValue_minecraftAccountId_changedAt_idx" ON "ItemWorthValue"("minecraftAccountId", "changedAt");
