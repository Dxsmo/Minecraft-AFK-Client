-- AlterTable: add HugoSMP-style server settings integration columns.
ALTER TABLE "MinecraftAccount" ADD COLUMN "hugoSettingsCommand" TEXT NOT NULL DEFAULT '/settings';
ALTER TABLE "MinecraftAccount" ADD COLUMN "hugoSettingsJson" TEXT NOT NULL DEFAULT '[]';
