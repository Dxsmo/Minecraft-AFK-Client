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
      { minecraftAccountId: account.id, amount: 9999, createdAt: minutes(25 * 60 + 1) },
      { minecraftAccountId: other.id, amount: 8888, createdAt: minutes(1) },
    ] });
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(await getEarningsSummary(account.id)).toEqual({ last5m: 1571.3, last1h: 1771.3, last24h: 2071.3 });
      // GET is read-only: cleanup runs on its own schedule.
      expect(await prisma.sellEarning.count({ where: { minecraftAccountId: account.id } })).toBe(8);
      await pruneOldEarnings();
      expect(await prisma.sellEarning.count({ where: { minecraftAccountId: account.id } })).toBe(7);
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

  it.each([['30m', 6, 5], ['1h', 12, 5], ['6h', 72, 5], ['24h', 288, 5]] as const)("aggregates %s into completed clock-aligned intervals with cents and empty gaps", async (range, buckets, minutes) => {
    const account = await prisma.minecraftAccount.create({ data: { name: `Graph_${range}`, serverHost: "localhost" } });
    const other = await prisma.minecraftAccount.create({ data: { name: `Other_${range}`, serverHost: "localhost" } });
    const now = Date.UTC(2026, 9, 9, 13, 47, 31), bucketMs = minutes * 60_000;
    const end = Math.floor(now / bucketMs) * bucketMs, start = end - buckets * bucketMs;
    await prisma.sellEarning.createMany({ data: [
      { minecraftAccountId: account.id, amount: 10, createdAt: new Date(start) },
      { minecraftAccountId: account.id, amount: 0.1, createdAt: new Date(start + bucketMs) },
      { minecraftAccountId: account.id, amount: 0.2, createdAt: new Date(start + bucketMs + 1) },
      { minecraftAccountId: account.id, amount: 20, createdAt: new Date(end - 1) },
      { minecraftAccountId: account.id, amount: 9999, createdAt: new Date(start - 1) },
      { minecraftAccountId: account.id, amount: 9999, createdAt: new Date(now + 1) },
      { minecraftAccountId: account.id, amount: 9999, createdAt: new Date(end) },
      { minecraftAccountId: account.id, amount: 9999, createdAt: new Date(now) },
      { minecraftAccountId: other.id, amount: 8888, createdAt: new Date(end - 1000) },
    ] });
    const result = await getEarningsHistory(account.id, range, now);
    expect(result.total).toBe(30.3);
    expect(result.bucketMs).toBe(bucketMs);
    expect(result.start).toBe(new Date(start).toISOString());
    expect(result.end).toBe(new Date(end).toISOString());
    expect(result.points).toHaveLength(buckets);
    expect(result.points[0]).toEqual({ at: new Date(start).toISOString(), amount: 10 });
    expect(result.points[1].amount).toBe(0.3);
    expect(result.points[2].amount).toBe(0);
    expect(result.points.at(-1)!.amount).toBe(20);
    expect(await prisma.sellEarning.count({ where: { minecraftAccountId: account.id } })).toBe(8);
  });

  it("returns a zero-filled graph for accounts without any sales", async () => {
    const account = await prisma.minecraftAccount.create({ data: { name: "EmptyGraph", serverHost: "localhost" } });
    const history = await getEarningsHistory(account.id, "24h");
    expect(history.total).toBe(0);
    expect(history.points).toHaveLength(288);
    expect(history.points.every(point => point.amount === 0)).toBe(true);
  });

  it.each([['30m', 5], ['1h', 5], ['6h', 5], ['24h', 5]] as const)("keeps %s stable inside an interval and includes a sale exactly once after the boundary", async (range, minutes) => {
    const account = await prisma.minecraftAccount.create({ data: { name: `Aligned_${range}`, serverHost: "localhost" } });
    const bucketMs = minutes * 60_000, boundary = Date.UTC(2026, 9, 9, 13);
    await prisma.sellEarning.createMany({ data: [
      { minecraftAccountId: account.id, amount: 10, createdAt: new Date(boundary - 1) },
      { minecraftAccountId: account.id, amount: 20, createdAt: new Date(boundary) },
    ] });
    const initial = await getEarningsHistory(account.id, range, boundary);
    expect(initial.total).toBe(10);
    expect(await getEarningsHistory(account.id, range, boundary + bucketMs - 1)).toEqual(initial);
    const next = await getEarningsHistory(account.id, range, boundary + bucketMs);
    expect(next.total).toBe(30);
    expect(next.points.at(-1)?.amount).toBe(20);
    expect(next.points.at(-2)?.amount).toBe(10);
  });

  it("preserves the oldest full five-minute graph bucket when pruning rolling 24h earnings", async () => {
    const account = await prisma.minecraftAccount.create({ data: { name: "RetentionGraph", serverHost: "localhost" } });
    const now = Date.UTC(2026, 9, 9, 13, 59, 59), hour = 60 * 60_000;
    const start = Math.floor(now / 300_000) * 300_000 - 24 * hour;
    await prisma.sellEarning.createMany({ data: [
      { minecraftAccountId: account.id, amount: 42, createdAt: new Date(start) },
      { minecraftAccountId: account.id, amount: 9999, createdAt: new Date(now - 25 * hour - 1) },
    ] });
    await pruneOldEarnings(now);
    expect((await getEarningsHistory(account.id, "24h", now)).points[0].amount).toBe(42);
    expect(await prisma.sellEarning.count({ where: { minecraftAccountId: account.id } })).toBe(1);
  });

});
