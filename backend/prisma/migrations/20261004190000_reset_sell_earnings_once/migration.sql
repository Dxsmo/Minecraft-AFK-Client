-- Discard the payouts recorded by the old parser so all rolling revenue
-- windows start from zero. Prisma tracks this migration, so later deployments
-- and restarts preserve newly recorded sales.
DELETE FROM "SellEarning";
