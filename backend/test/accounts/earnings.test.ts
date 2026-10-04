import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/database/prisma.js";
import { getEarningsSummary } from "../../src/accounts/service.js";

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
      expect(await prisma.sellEarning.count({ where: { minecraftAccountId: account.id } })).toBe(6);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
