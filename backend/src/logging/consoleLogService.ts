import { prisma } from "../database/prisma.js";
import type { ConsoleLogType } from "@prisma/client";

const MAX_LOGS_PER_ACCOUNT = 2000;

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
      orderBy: { createdAt: "asc" },
      take: excess,
      select: { id: true },
    });
    await prisma.consoleLog.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } });
  }
}

export async function getConsoleLogs(minecraftAccountId: string, limit = 200) {
  return prisma.consoleLog.findMany({
    where: { minecraftAccountId },
    orderBy: { createdAt: "desc" },
    take: limit,
  }).then((logs) => logs.reverse());
}
