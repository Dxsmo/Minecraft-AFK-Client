import { buildApp } from "./app.js";
import { config } from "./config/config.js";
import { logger } from "./logging/logger.js";
import { bootstrapAdmin } from "./auth/bootstrapAdmin.js";
import { pruneExpiredSessions, clearAllSessions } from "./auth/session.js";
import { clientManager } from "./minecraft/ClientManager.js";
import { sniperManager } from "./namesniper/SniperManager.js";
import { disconnectDatabase } from "./database/prisma.js";
import { purgeStoredPasswords } from "./accounts/service.js";
import { loadBannedIps } from "./security/ipBans.js";

const SESSION_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly

async function main() {
  await bootstrapAdmin();
  // Strip any Minecraft passwords still stored on legacy accounts. Accounts are
  // preserved; only the stored password is removed (device-code sign-in only).
  const purged = await purgeStoredPasswords();
  if (purged > 0) logger.info({ purged }, "Cleared stored Minecraft passwords from existing accounts");
  // Every backend restart requires everyone to log in again (explicit
  // product requirement), rather than resuming previously-valid sessions.
  await clearAllSessions();
  await clientManager.loadAll();
  await sniperManager.loadAll();
  await loadBannedIps();

  const app = await buildApp();

  const pruneInterval = setInterval(() => {
    pruneExpiredSessions().catch((err) => logger.error({ err }, "Failed to prune sessions"));
  }, SESSION_PRUNE_INTERVAL_MS);

  await app.listen({ host: config.host, port: config.port });
  logger.info({ host: config.host, port: config.port }, "AFK backend listening");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down gracefully...");
    clearInterval(pruneInterval);
    clientManager.shutdownAll();
    sniperManager.shutdownAll();
    await app.close();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Last line of defense: never let one unexpected error crash the whole
  // service (which would disconnect every Minecraft client at once).
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception");
  });
  process.on("unhandledRejection", (err) => {
    logger.error({ err }, "Unhandled promise rejection");
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
