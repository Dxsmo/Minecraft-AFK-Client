-- The former "auto command" is now "Auto home" and may only run "/home <name>".
-- Clear any legacy command that no longer fits so the scheduler can never keep
-- executing an arbitrary command that the UI can no longer display or edit.
UPDATE "MinecraftAccount"
SET "autoCommandText" = ''
WHERE "autoCommandText" NOT LIKE '/home %';
