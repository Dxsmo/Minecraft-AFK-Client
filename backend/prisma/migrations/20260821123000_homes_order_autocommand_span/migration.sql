ALTER TABLE "MinecraftAccount" ADD COLUMN "autoCommandSpanEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MinecraftAccount" ADD COLUMN "autoCommandSpanMinSeconds" INTEGER NOT NULL DEFAULT 600;
ALTER TABLE "MinecraftAccount" ADD COLUMN "autoCommandSpanMaxSeconds" INTEGER NOT NULL DEFAULT 1800;
ALTER TABLE "MinecraftAccount" ADD COLUMN "homesJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "MinecraftAccount" ADD COLUMN "dashboardOrder" INTEGER NOT NULL DEFAULT 0;
