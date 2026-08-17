-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MinecraftAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "minecraftVersion" TEXT NOT NULL DEFAULT '',
    "serverHost" TEXT NOT NULL,
    "serverPort" INTEGER NOT NULL DEFAULT 25565,
    "authType" TEXT NOT NULL DEFAULT 'OFFLINE',
    "credentialsSecret" TEXT,
    "credentialsPassword" TEXT,
    "afkEnabled" BOOLEAN NOT NULL DEFAULT true,
    "movementEnabled" BOOLEAN NOT NULL DEFAULT false,
    "afkIntervalSeconds" INTEGER NOT NULL DEFAULT 30,
    "autoReconnect" BOOLEAN NOT NULL DEFAULT true,
    "autoCommandEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoCommandText" TEXT NOT NULL DEFAULT '',
    "autoCommandIntervalMinutes" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'OFFLINE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_MinecraftAccount" ("afkEnabled", "afkIntervalSeconds", "authType", "autoCommandEnabled", "autoCommandIntervalMinutes", "autoCommandText", "autoReconnect", "createdAt", "credentialsPassword", "credentialsSecret", "id", "minecraftVersion", "movementEnabled", "name", "serverHost", "serverPort", "status", "updatedAt") SELECT "afkEnabled", "afkIntervalSeconds", "authType", "autoCommandEnabled", "autoCommandIntervalMinutes", "autoCommandText", "autoReconnect", "createdAt", "credentialsPassword", "credentialsSecret", "id", "minecraftVersion", "movementEnabled", "name", "serverHost", "serverPort", "status", "updatedAt" FROM "MinecraftAccount";
DROP TABLE "MinecraftAccount";
ALTER TABLE "new_MinecraftAccount" RENAME TO "MinecraftAccount";
CREATE UNIQUE INDEX "MinecraftAccount_name_key" ON "MinecraftAccount"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
