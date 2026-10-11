import { prisma } from "../database/prisma.js";
import type { ConsoleLogType, Prisma } from "@prisma/client";
import { createBufferedWriter } from "./bufferedWriter.js";

const MAX_LOGS_PER_ACCOUNT = 2000;

const writer = createBufferedWriter<Prisma.SniperLogCreateManyInput>(async rows => {
  const accountIds = [...new Set(rows.map(row => row.sniperAccountId))];
  await prisma.$transaction([
    prisma.sniperLog.createMany({ data: rows }),
    ...accountIds.map(accountId => prisma.$executeRaw`
      DELETE FROM "SniperLog"
      WHERE "sniperAccountId" = ${accountId}
        AND ("createdAt", "id") < (
          SELECT "createdAt", "id" FROM "SniperLog"
          WHERE "sniperAccountId" = ${accountId}
          ORDER BY "createdAt" DESC, "id" DESC
          LIMIT 1 OFFSET ${MAX_LOGS_PER_ACCOUNT - 1}
        )
    `),
  ]);
});

export const flushSniperLogs = () => writer.flush();

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
  await writer.enqueue({ sniperAccountId, type, message, createdAt: new Date() });
}

export async function getSniperLogs(sniperAccountId: string, limit = 200) {
  return prisma.sniperLog.findMany({
    where: { sniperAccountId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Number.isFinite(limit) ? Math.max(1, Math.min(MAX_LOGS_PER_ACCOUNT, Math.floor(limit))) : 200,
  }).then((logs) => logs.reverse());
}
