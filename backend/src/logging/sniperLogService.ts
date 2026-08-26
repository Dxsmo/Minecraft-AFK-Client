import { prisma } from "../database/prisma.js";
import type { ConsoleLogType } from "@prisma/client";

const MAX_LOGS_PER_ACCOUNT = 2000;

/**
 * Persists a console line for a Name Sniper account and prunes old entries so
 * the SQLite database doesn't grow unbounded on a long-running Raspberry Pi.
 * Mirrors persistConsoleLog/getConsoleLogs in consoleLogService.ts exactly,
 * just pointed at the SniperLog table.
 */
export async function persistSniperLog(
  sniperAccountId: string,
  type: ConsoleLogType,
  message: string,
): Promise<void> {
  await prisma.sniperLog.create({
    data: { sniperAccountId, type, message },
  });

  const count = await prisma.sniperLog.count({ where: { sniperAccountId } });
  if (count > MAX_LOGS_PER_ACCOUNT) {
    const excess = count - MAX_LOGS_PER_ACCOUNT;
    const oldest = await prisma.sniperLog.findMany({
      where: { sniperAccountId },
      orderBy: { createdAt: "asc" },
      take: excess,
      select: { id: true },
    });
    await prisma.sniperLog.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } });
  }
}

export async function getSniperLogs(sniperAccountId: string, limit = 200) {
  return prisma.sniperLog.findMany({
    where: { sniperAccountId },
    orderBy: { createdAt: "desc" },
    take: limit,
  }).then((logs) => logs.reverse());
}
