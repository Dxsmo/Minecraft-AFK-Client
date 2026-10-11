import { prisma } from "../database/prisma.js";
import type { ConsoleLogType, Prisma } from "@prisma/client";
import { createBufferedWriter } from "./bufferedWriter.js";

export const MAX_LOGS_PER_ACCOUNT = 20_000;
export const CONSOLE_HISTORY_PAGE_SIZE = 2000;

const writer = createBufferedWriter<Prisma.ConsoleLogCreateManyInput>(async rows => {
  const accountIds = [...new Set(rows.map(row => row.minecraftAccountId))];
  await prisma.$transaction([
    prisma.consoleLog.createMany({ data: rows }),
    ...accountIds.map(accountId => prisma.$executeRaw`
      DELETE FROM "ConsoleLog"
      WHERE "minecraftAccountId" = ${accountId}
        AND ("createdAt", "id") < (
          SELECT "createdAt", "id" FROM "ConsoleLog"
          WHERE "minecraftAccountId" = ${accountId}
          ORDER BY "createdAt" DESC, "id" DESC
          LIMIT 1 OFFSET ${MAX_LOGS_PER_ACCOUNT - 1}
        )
    `),
  ]);
});

export const flushConsoleLogs = () => writer.flush();

/**
 * Persists a console line for a Minecraft account and prunes old entries so
 * the SQLite database doesn't grow unbounded on a long-running Raspberry Pi.
 */
export async function persistConsoleLog(
  minecraftAccountId: string,
  type: ConsoleLogType,
  message: string,
): Promise<void> {
  // Timestamp the event now, not when its batch eventually reaches SQLite.
  await writer.enqueue({ minecraftAccountId, type, message, createdAt: new Date() });
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
