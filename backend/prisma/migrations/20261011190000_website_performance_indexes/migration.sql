-- Cover earnings aggregations using only the index, without reading each sale row.
CREATE INDEX "SellEarning_minecraftAccountId_createdAt_amount_idx" ON "SellEarning"("minecraftAccountId", "createdAt", "amount");
DROP INDEX "SellEarning_minecraftAccountId_createdAt_idx";
-- Hourly retention must not scan the complete tables while requests are loading.
CREATE INDEX "SellEarning_createdAt_idx" ON "SellEarning"("createdAt");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
CREATE INDEX "MinecraftAccount_dashboardOrder_name_idx" ON "MinecraftAccount"("dashboardOrder", "name");
-- The existing unique username index is case-sensitive. Keep legacy duplicate
-- handling intact and support the parameterized NOCASE login/access lookup.
CREATE INDEX "User_username_nocase_idx" ON "User"("username" COLLATE NOCASE);
