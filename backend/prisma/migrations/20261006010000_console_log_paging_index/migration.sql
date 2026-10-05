CREATE INDEX "ConsoleLog_minecraftAccountId_createdAt_id_idx" ON "ConsoleLog"("minecraftAccountId", "createdAt", "id");
DROP INDEX "ConsoleLog_minecraftAccountId_createdAt_idx";
