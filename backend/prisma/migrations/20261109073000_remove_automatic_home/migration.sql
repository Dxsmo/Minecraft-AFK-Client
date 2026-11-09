ALTER TABLE "MinecraftAccount" DROP COLUMN "autoReturnHome";
UPDATE "MinecraftAccount" SET "autoSellCommand" = '/sell';
