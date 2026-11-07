import { PrismaClient } from "@prisma/client";
import { sqliteConnectionUrl } from "./connectionUrl.js";

/**
 * Singleton Prisma client. Kept in its own module so every part of the
 * backend shares one connection pool / SQLite file handle.
 */
export const prisma = new PrismaClient({
  ...(process.env.DATABASE_URL ? { datasourceUrl: sqliteConnectionUrl(process.env.DATABASE_URL) } : {}),
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

/** Let readers proceed while a batched log/earning transaction is writing.
 * Configure this before startup cleanup and before any clients can emit logs. */
export async function initializeDatabase(): Promise<void> {
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
