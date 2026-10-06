-- CreateTable
CREATE TABLE "MinigameLobby" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "hostUuid" TEXT NOT NULL,
    "game" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "snapshot" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "MinigameMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lobbyId" TEXT NOT NULL,
    "playerUuid" TEXT NOT NULL,
    "activePlayer" TEXT,
    "snapshot" TEXT NOT NULL,
    CONSTRAINT "MinigameMember_lobbyId_fkey" FOREIGN KEY ("lobbyId") REFERENCES "MinigameLobby" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MinigameEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lobbyId" TEXT,
    "playerUuid" TEXT,
    "game" TEXT,
    "type" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MinigameEvent_lobbyId_fkey" FOREIGN KEY ("lobbyId") REFERENCES "MinigameLobby" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MinigamePlayer" (
    "uuid" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "minecraftVersion" TEXT NOT NULL,
    "modVersion" TEXT NOT NULL,
    "protocolVersion" INTEGER NOT NULL,
    "network" TEXT NOT NULL,
    "capabilities" TEXT NOT NULL,
    "itemIds" TEXT NOT NULL,
    "streamerMode" BOOLEAN NOT NULL DEFAULT false,
    "connectionState" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "lastSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MinigameSession" (
    "tokenHash" TEXT NOT NULL PRIMARY KEY,
    "playerUuid" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MinigameChallenge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MinigameContent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MinigameStats" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerUuid" TEXT NOT NULL,
    "game" TEXT NOT NULL,
    "gamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "metrics" TEXT NOT NULL DEFAULT '{}'
);

-- CreateTable
CREATE TABLE "MinigameReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerUuid" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "MinigameLobby_code_key" ON "MinigameLobby"("code");

-- CreateIndex
CREATE INDEX "MinigameLobby_state_createdAt_idx" ON "MinigameLobby"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MinigameMember_activePlayer_key" ON "MinigameMember"("activePlayer");

-- CreateIndex
CREATE UNIQUE INDEX "MinigameMember_lobbyId_playerUuid_key" ON "MinigameMember"("lobbyId", "playerUuid");

-- CreateIndex
CREATE INDEX "MinigameEvent_lobbyId_createdAt_idx" ON "MinigameEvent"("lobbyId", "createdAt");

-- CreateIndex
CREATE INDEX "MinigameEvent_playerUuid_createdAt_idx" ON "MinigameEvent"("playerUuid", "createdAt");

-- CreateIndex
CREATE INDEX "MinigameEvent_type_createdAt_idx" ON "MinigameEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "MinigameSession_expiresAt_idx" ON "MinigameSession"("expiresAt");

-- CreateIndex
CREATE INDEX "MinigameContent_kind_enabled_idx" ON "MinigameContent"("kind", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "MinigameStats_playerUuid_game_key" ON "MinigameStats"("playerUuid", "game");

-- CreateIndex
CREATE INDEX "MinigameReceipt_expiresAt_idx" ON "MinigameReceipt"("expiresAt");
