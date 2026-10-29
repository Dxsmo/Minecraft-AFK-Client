-- Remove only the retired cross-edition feature's metadata. Every account,
-- credential cache, setting, assignment and history entry remains independent.
DROP INDEX "MinecraftAccount_linkedAccountId_key";
ALTER TABLE "MinecraftAccount" DROP COLUMN "linkedAccountId";
ALTER TABLE "MinecraftAccount" DROP COLUMN "autoAddOtherEdition";
