-- AlterTable: per-account spawner clearing configuration
ALTER TABLE "MinecraftAccount" ADD COLUMN "spawnerType" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MinecraftAccount" ADD COLUMN "spawnerActions" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "MinecraftAccount" ADD COLUMN "spawnerClearEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MinecraftAccount" ADD COLUMN "spawnerClearTimes" TEXT NOT NULL DEFAULT '[]';
