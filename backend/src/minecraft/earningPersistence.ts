import type { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { createBufferedWriter } from "../logging/bufferedWriter.js";

/** Preserve every payout while committing a burst as one transaction. A full
 * sale must not enqueue 36 separate transactions ahead of interactive reads. */
const earnings = createBufferedWriter<Prisma.SellEarningCreateManyInput>(async rows => {
  const latest = new Map<string, Date>();
  for (const row of rows) {
    const at = new Date(row.createdAt!);
    if (!latest.has(row.minecraftAccountId) || at > latest.get(row.minecraftAccountId)!) latest.set(row.minecraftAccountId, at);
  }
  await prisma.$transaction([
    prisma.sellEarning.createMany({ data: rows }),
    ...[...latest].map(([id, at]) => prisma.minecraftAccount.updateMany({
      where: { id, OR: [{ lastSellAt: null }, { lastSellAt: { lte: at } }] }, data: { lastSellAt: at },
    })),
  ]);
});

export const flushSellEarnings = () => earnings.flush();
export const persistSellEarning = (minecraftAccountId: string, amount: number, createdAt: Date): Promise<void> =>
  earnings.enqueue({ minecraftAccountId, amount, createdAt });
