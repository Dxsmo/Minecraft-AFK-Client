-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SniperAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL,
    "desiredName" TEXT NOT NULL DEFAULT '',
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 5,
    "rateLimitProtection" BOOLEAN NOT NULL DEFAULT false,
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
INSERT INTO "new_SniperAccount" ("cooldownSeconds", "createdAt", "createdById", "currentName", "dashboardOrder", "desiredName", "email", "enabled", "id", "label", "lastAttemptAt", "lastResult", "lastSuccess", "status", "updatedAt") SELECT "cooldownSeconds", "createdAt", "createdById", "currentName", "dashboardOrder", "desiredName", "email", "enabled", "id", "label", "lastAttemptAt", "lastResult", "lastSuccess", "status", "updatedAt" FROM "SniperAccount";
DROP TABLE "SniperAccount";
ALTER TABLE "new_SniperAccount" RENAME TO "SniperAccount";
CREATE UNIQUE INDEX "SniperAccount_email_key" ON "SniperAccount"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
