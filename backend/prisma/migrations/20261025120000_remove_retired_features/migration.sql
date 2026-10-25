-- Erase retired feature data instead of retaining legacy tables or archives.
PRAGMA secure_delete = ON;

DROP TABLE IF EXISTS "ItemWorthRunValue";
DROP TABLE IF EXISTS "ItemWorthRun";
DROP TABLE IF EXISTS "ItemWorthValue";
DROP TABLE IF EXISTS "ItemWorthScan";
DROP TABLE IF EXISTS "SniperLog";
DROP TABLE IF EXISTS "SniperAccount";
DROP TABLE IF EXISTS "MinigameReceipt";
DROP TABLE IF EXISTS "MinigameSession";
DROP TABLE IF EXISTS "MinigameChallenge";
DROP TABLE IF EXISTS "MinigameMember";
DROP TABLE IF EXISTS "MinigameEvent";
DROP TABLE IF EXISTS "MinigameLobby";
DROP TABLE IF EXISTS "MinigamePlayer";
DROP TABLE IF EXISTS "MinigameContent";
DROP TABLE IF EXISTS "MinigameStats";

DELETE FROM "AuditLog"
WHERE lower("action") LIKE '%sniper%'
   OR lower("action") LIKE '%minigame%'
   OR lower("action") LIKE '%item%worth%'
   OR lower(coalesce("targetType", '')) LIKE '%sniper%'
   OR lower(coalesce("targetType", '')) LIKE '%minigame%'
   OR lower(coalesce("targetType", '')) LIKE '%item%worth%'
   OR lower(coalesce("details", '')) LIKE '%/worth %';

DELETE FROM "ConsoleLog"
WHERE lower("message") LIKE '%/worth %'
   OR lower("message") LIKE '%item-worth%'
   OR lower("message") LIKE '%item wert%';
