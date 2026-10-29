ALTER TABLE "MinecraftAccount" ADD COLUMN "autoAddOtherEdition" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MinecraftAccount" ADD COLUMN "linkedAccountId" TEXT;
CREATE UNIQUE INDEX "MinecraftAccount_linkedAccountId_key" ON "MinecraftAccount"("linkedAccountId");
