-- CreateTable
CREATE TABLE "SniperAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL,
    "desiredName" TEXT NOT NULL DEFAULT '',
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 5,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'OFFLINE',
    "currentName" TEXT,
    "lastAttemptAt" DATETIME,
    "lastResult" TEXT,
    "lastSuccess" BOOLEAN NOT NULL DEFAULT false,
    "dashboardOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdById" TEXT,
    CONSTRAINT "SniperAccount_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SniperLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sniperAccountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SniperLog_sniperAccountId_fkey" FOREIGN KEY ("sniperAccountId") REFERENCES "SniperAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SniperAccount_email_key" ON "SniperAccount"("email");

-- CreateIndex
CREATE INDEX "SniperLog_sniperAccountId_createdAt_idx" ON "SniperLog"("sniperAccountId", "createdAt");
