-- Removes the dashboard account icon feature entirely, per request to
-- revert it after it was added in 20260825140000_add_icon_name.
ALTER TABLE "MinecraftAccount" DROP COLUMN "iconName";
