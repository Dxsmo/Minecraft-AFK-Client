import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ClientManager } from "../../src/minecraft/ClientManager.js";
import { prisma } from "../../src/database/prisma.js";
import { pruneOldEarnings } from "../../src/accounts/service.js";

let manager: ClientManager;
let accountId: string;
beforeEach(async () => {
  manager = new ClientManager();
  const account = await prisma.minecraftAccount.create({ data: {
    name: `Sale_${randomUUID()}`, serverHost: "localhost",
  } });
  accountId = account.id;
  manager.register(account);
});
afterEach(async () => {
  manager.unregister(accountId);
  await prisma.minecraftAccount.delete({ where: { id: accountId } });
});

it("records and broadcasts a confirmed sale, retaining its time after history cleanup and client recreation", async () => {
  const before = Date.now();
  const update = new Promise<{ id: string; lastSellAt: string }>((resolve) => manager.onSellEvent(resolve));
  manager.get(accountId)!.emit("earning", { minecraftAccountId: accountId, amount: 42.5 });
  const event = await update;
  const account = await prisma.minecraftAccount.findUniqueOrThrow({ where: { id: accountId } });
  const earnings = await prisma.sellEarning.findMany({ where: { minecraftAccountId: accountId } });
  expect(event.id).toBe(accountId);
  expect(Date.parse(event.lastSellAt)).toBeGreaterThanOrEqual(before);
  expect(account.lastSellAt?.toISOString()).toBe(event.lastSellAt);
  expect(earnings).toHaveLength(1);
  expect(earnings[0].amount).toBe(42.5);
  expect(earnings[0].createdAt.toISOString()).toBe(event.lastSellAt);

  await pruneOldEarnings(Date.parse(event.lastSellAt) + 26 * 3_600_000);
  expect(await prisma.sellEarning.count({ where: { minecraftAccountId: accountId } })).toBe(0);
  manager.unregister(accountId);
  const restored = await prisma.minecraftAccount.findUniqueOrThrow({ where: { id: accountId } });
  manager.register(restored);
  expect(restored.lastSellAt?.toISOString()).toBe(event.lastSellAt);
});

it("starts with no confirmed sale and never moves the persisted time backwards", async () => {
  expect((await prisma.minecraftAccount.findUniqueOrThrow({ where: { id: accountId } })).lastSellAt).toBeNull();
  const later = new Date(Date.now() + 1000);
  await prisma.minecraftAccount.update({ where: { id: accountId }, data: { lastSellAt: later } });
  const update = new Promise((resolve) => manager.onSellEvent(resolve));
  manager.get(accountId)!.emit("earning", { minecraftAccountId: accountId, amount: 7 });
  await update;
  expect((await prisma.minecraftAccount.findUniqueOrThrow({ where: { id: accountId } })).lastSellAt).toEqual(later);
  expect(await prisma.sellEarning.count({ where: { minecraftAccountId: accountId } })).toBe(1);
});
