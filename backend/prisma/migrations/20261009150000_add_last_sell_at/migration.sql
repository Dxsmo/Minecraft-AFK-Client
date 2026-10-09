ALTER TABLE "MinecraftAccount" ADD COLUMN "lastSellAt" DATETIME;

UPDATE "MinecraftAccount"
SET "lastSellAt" = (
  SELECT MAX("createdAt") FROM "SellEarning"
  WHERE "minecraftAccountId" = "MinecraftAccount"."id"
);
