import { prisma } from "../database/prisma.js";
import type { ConsoleLogType } from "@prisma/client";

export const MAX_LOGS_PER_ACCOUNT = 20_000;
export const CONSOLE_HISTORY_PAGE_SIZE = 2000;

/**
 * Persists a console line for a Minecraft account and prunes old entries so
 * the SQLite database doesn't grow unbounded on a long-running Raspberry Pi.
 */
export async function persistConsoleLog(
  minecraftAccountId: string,
  type: ConsoleLogType,
  message: string,
): Promise<void> {
  await prisma.consoleLog.create({
    data: { minecraftAccountId, type, message },
  });

  const count = await prisma.consoleLog.count({ where: { minecraftAccountId } });
  if (count > MAX_LOGS_PER_ACCOUNT) {
    const excess = count - MAX_LOGS_PER_ACCOUNT;
    const oldest = await prisma.consoleLog.findMany({
      where: { minecraftAccountId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: excess,
      select: { id: true },
    });
    await prisma.consoleLog.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } });
  }
}

export async function getConsoleLogs(minecraftAccountId: string, limit = CONSOLE_HISTORY_PAGE_SIZE, before?: string) {
  const take = Number.isFinite(limit)
    ? Math.max(1, Math.min(CONSOLE_HISTORY_PAGE_SIZE, Math.floor(limit)))
    : CONSOLE_HISTORY_PAGE_SIZE;
  const cursor = before ? await prisma.consoleLog.findFirst({
    where: { id: before, minecraftAccountId },
    select: { id: true, createdAt: true },
  }) : null;
  if (before && !cursor) return [];
  return prisma.consoleLog.findMany({
    where: {
      minecraftAccountId,
      ...(cursor ? { OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  }).then((logs) => logs.reverse());
}
