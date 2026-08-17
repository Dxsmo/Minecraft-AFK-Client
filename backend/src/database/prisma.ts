import { PrismaClient } from "@prisma/client";

/**
 * Singleton Prisma client. Kept in its own module so every part of the
 * backend shares one connection pool / SQLite file handle.
 */
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
