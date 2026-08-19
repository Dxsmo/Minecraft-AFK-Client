-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MinecraftAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "minecraftVersion" TEXT NOT NULL DEFAULT '',
    "serverHost" TEXT NOT NULL,
    "serverPort" INTEGER NOT NULL DEFAULT 25565,
    "authType" TEXT NOT NULL DEFAULT 'OFFLINE',
    "credentialsSecret" TEXT,
    "credentialsPassword" TEXT,
    "afkEnabled" BOOLEAN NOT NULL DEFAULT true,
    "movementEnabled" BOOLEAN NOT NULL DEFAULT false,
    "crouchEnabled" BOOLEAN NOT NULL DEFAULT false,
    "afkIntervalSeconds" INTEGER NOT NULL DEFAULT 30,
    "autoReconnect" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT NOT NULL DEFAULT '',
    "autoCommandEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoCommandText" TEXT NOT NULL DEFAULT '',
    "autoCommandIntervalMinutes" INTEGER NOT NULL DEFAULT 5,
    "tpAutoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "tpAutoAllowlist" TEXT NOT NULL DEFAULT '[]',
    "autoSellEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoSellIntervalSeconds" INTEGER NOT NULL DEFAULT 60,
    "autoSellCommand" TEXT NOT NULL DEFAULT '/sell',
    "status" TEXT NOT NULL DEFAULT 'OFFLINE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdById" TEXT,
    CONSTRAINT "MinecraftAccount_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_MinecraftAccount" ("afkEnabled", "afkIntervalSeconds", "authType", "autoCommandEnabled", "autoCommandIntervalMinutes", "autoCommandText", "autoReconnect", "autoSellCommand", "autoSellEnabled", "autoSellIntervalSeconds", "createdAt", "createdById", "credentialsPassword", "credentialsSecret", "id", "minecraftVersion", "movementEnabled", "name", "serverHost", "serverPort", "status", "tpAutoAllowlist", "tpAutoEnabled", "updatedAt") SELECT "afkEnabled", "afkIntervalSeconds", "authType", "autoCommandEnabled", "autoCommandIntervalMinutes", "autoCommandText", "autoReconnect", "autoSellCommand", "autoSellEnabled", "autoSellIntervalSeconds", "createdAt", "createdById", "credentialsPassword", "credentialsSecret", "id", "minecraftVersion", "movementEnabled", "name", "serverHost", "serverPort", "status", "tpAutoAllowlist", "tpAutoEnabled", "updatedAt" FROM "MinecraftAccount";
DROP TABLE "MinecraftAccount";
ALTER TABLE "new_MinecraftAccount" RENAME TO "MinecraftAccount";
CREATE UNIQUE INDEX "MinecraftAccount_name_key" ON "MinecraftAccount"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
