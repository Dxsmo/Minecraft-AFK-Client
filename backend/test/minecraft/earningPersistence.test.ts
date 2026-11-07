import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/database/prisma.js";
import { flushSellEarnings, persistSellEarning } from "../../src/minecraft/earningPersistence.js";
const ids: string[] = [];
async function account() {
  const row = await prisma.minecraftAccount.create({ data: { name: `Burst-${randomUUID()}`, serverHost: "localhost" } });
  ids.push(row.id); return row.id;
}
afterEach(async () => {
  await flushSellEarnings(); vi.restoreAllMocks();
  await prisma.minecraftAccount.deleteMany({ where: { id: { in: ids.splice(0) } } });
});
it("preserves all 36 payouts in one transaction without moving the latest sale backwards", async () => {
  const id = await account(), start = Date.now();
  const spy = vi.spyOn(prisma, "$transaction");
  const pending = Array.from({ length: 36 }, (_, i) => persistSellEarning(id, i + 0.5, new Date(start + i)));
  await flushSellEarnings(); await Promise.all(pending);
  expect(spy).toHaveBeenCalledTimes(1);
  const rows = await prisma.sellEarning.findMany({ where: { minecraftAccountId: id } });
  expect(rows).toHaveLength(36); expect(rows.reduce((sum, row) => sum + row.amount, 0)).toBe(648);
  expect((await prisma.minecraftAccount.findUniqueOrThrow({ where: { id } })).lastSellAt?.getTime()).toBe(start + 35);
  const older = persistSellEarning(id, 1, new Date(start - 1000)); await flushSellEarnings(); await older;
  expect((await prisma.minecraftAccount.findUniqueOrThrow({ where: { id } })).lastSellAt?.getTime()).toBe(start + 35);
});
it("isolates a deleted account's failure without dropping or duplicating another account's payout", async () => {
  const id = await account();
  const good = persistSellEarning(id, 42, new Date());
  const deleted = persistSellEarning("deleted-account", 17, new Date()).then(() => false, () => true);
  await flushSellEarnings(); await good; expect(await deleted).toBe(true);
  const rows = await prisma.sellEarning.findMany({ where: { minecraftAccountId: id } });
  expect(rows.map(row => row.amount)).toEqual([42]);
});
