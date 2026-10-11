-- Deterministic sniper log retention, including messages sharing a timestamp.
CREATE INDEX "SniperLog_sniperAccountId_createdAt_id_idx" ON "SniperLog"("sniperAccountId", "createdAt", "id");
DROP INDEX "SniperLog_sniperAccountId_createdAt_idx";
