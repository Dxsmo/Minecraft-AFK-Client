import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/database/prisma.js";
import { getEarningsSummary, getEarningsHistory, pruneOldEarnings } from "../../src/accounts/service.js";

describe("rolling sell revenue", () => {
  beforeEach(async () => {
    await prisma.minecraftAccount.deleteMany();
  });

  it("sums only the account's sales in each rolling window, including cents", async () => {
    const account = await prisma.minecraftAccount.create({ data: { name: "Earnings", serverHost: "localhost" } });
    const other = await prisma.minecraftAccount.create({ data: { name: "Other", serverHost: "localhost" } });
    const now = Date.now();
    const minutes = (n: number) => new Date(now - n * 60_000);
    await prisma.sellEarning.createMany({ data: [
      { minecraftAccountId: account.id, amount: 1071, createdAt: minutes(1) },
      { minecraftAccountId: account.id, amount: 0.1, createdAt: minutes(2) },
      { minecraftAccountId: account.id, amount: 0.2, createdAt: minutes(3) },
      { minecraftAccountId: account.id, amount: 500, createdAt: minutes(5) },
      { minecraftAccountId: account.id, amount: 200, createdAt: minutes(60) },
      { minecraftAccountId: account.id, amount: 300, createdAt: minutes(24 * 60) },
      { minecraftAccountId: account.id, amount: 9999, createdAt: minutes(24 * 60 + 1) },
      { minecraftAccountId: other.id, amount: 8888, createdAt: minutes(1) },
    ] });
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(await getEarningsSummary(account.id)).toEqual({ last5m: 1571.3, last1h: 1771.3, last24h: 2071.3 });
      // GET is read-only: cleanup runs on its own schedule.
      expect(await prisma.sellEarning.count({ where: { minecraftAccountId: account.id } })).toBe(7);
      await pruneOldEarnings();
      expect(await prisma.sellEarning.count({ where: { minecraftAccountId: account.id } })).toBe(6);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("returns zero for an empty account and excludes future sales", async () => {
    const account = await prisma.minecraftAccount.create({ data: { name: "Empty", serverHost: "localhost" } });
    expect(await getEarningsSummary(account.id)).toEqual({ last5m: 0, last1h: 0, last24h: 0 });
    await prisma.sellEarning.create({ data: { minecraftAccountId: account.id, amount: 999, createdAt: new Date(Date.now() + 60_000) } });
    expect(await getEarningsSummary(account.id)).toEqual({ last5m: 0, last1h: 0, last24h: 0 });
  });

  it.each([['1h', 60, 1], ['6h', 72, 5], ['24h', 96, 15]] as const)("aggregates %s into bounded intervals with cents, empty gaps and inclusive window edges", async (range, buckets, minutes) => {
    const account = await prisma.minecraftAccount.create({ data: { name: `Graph_${range}`, serverHost: "localhost" } });
    const other = await prisma.minecraftAccount.create({ data: { name: `Other_${range}`, serverHost: "localhost" } });
    const now = Date.now(), bucketMs = minutes * 60_000, start = now - buckets * bucketMs;
    await prisma.sellEarning.createMany({ data: [
      { minecraftAccountId: account.id, amount: 10, createdAt: new Date(start) },
      { minecraftAccountId: account.id, amount: 0.1, createdAt: new Date(start + bucketMs) },
      { minecraftAccountId: account.id, amount: 0.2, createdAt: new Date(start + bucketMs + 1) },
      { minecraftAccountId: account.id, amount: 20, createdAt: new Date(now) },
      { minecraftAccountId: account.id, amount: 9999, createdAt: new Date(start - 1) },
      { minecraftAccountId: account.id, amount: 9999, createdAt: new Date(now + 1) },
      { minecraftAccountId: other.id, amount: 8888, createdAt: new Date(now - 1000) },
    ] });
    const result = await getEarningsHistory(account.id, range, now);
    expect(result.total).toBe(30.3);
    expect(result.bucketMs).toBe(bucketMs);
    expect(result.points).toHaveLength(buckets);
    expect(result.points[0]).toEqual({ at: new Date(start).toISOString(), amount: 10 });
    expect(result.points[1].amount).toBe(0.3);
    expect(result.points[2].amount).toBe(0);
    expect(result.points.at(-1)!.amount).toBe(20);
    expect(await prisma.sellEarning.count({ where: { minecraftAccountId: account.id } })).toBe(6);
  });

  it("returns a zero-filled graph for accounts without any sales", async () => {
    const account = await prisma.minecraftAccount.create({ data: { name: "EmptyGraph", serverHost: "localhost" } });
    const history = await getEarningsHistory(account.id, "24h");
    expect(history.total).toBe(0);
    expect(history.points).toHaveLength(96);
    expect(history.points.every(point => point.amount === 0)).toBe(true);
  });

});
