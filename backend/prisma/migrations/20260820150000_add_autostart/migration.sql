-- Add persisted "should be running" intent flag. Additive: existing rows keep
-- all their data and default to autoStart = false (i.e. stay offline on boot).
ALTER TABLE "MinecraftAccount" ADD COLUMN "autoStart" BOOLEAN NOT NULL DEFAULT false;
