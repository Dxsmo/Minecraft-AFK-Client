import { performance } from "node:perf_hooks";
import { prisma } from "../src/database/prisma.js";
import { getEarningsSummary, getEarningsHistory, listAccountsForSession, listDashboardAccountsForSession, invalidateEarningsHistory } from "../src/accounts/service.js";
import { createSession, getSession } from "../src/auth/session.js";
import { getConsoleLogs, persistConsoleLog } from "../src/logging/consoleLogService.js";

if (process.env.NODE_ENV !== "test" || !process.env.DATABASE_URL?.endsWith("performance.db")) {
  throw new Error("Use NODE_ENV=test and an isolated performance.db; this benchmark creates test fixtures.");
}
async function measure(action: () => Promise<unknown>, runs: number) {
  await action();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await action();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { medianMs: +samples[Math.floor(runs / 2)].toFixed(2), p95Ms: +samples[Math.min(runs - 1, Math.floor(runs * .95))].toFixed(2) };
}
let accountId: string | undefined;
let userId: string | undefined;
const prefix = `Perf-${Date.now()}-`;
try {
  const account = await prisma.minecraftAccount.create({ data: { name: `Perf-${Date.now()}`, serverHost: "localhost" } });
  accountId = account.id;
  const user = await prisma.user.create({ data: { username: prefix + "user", passwordHash: "benchmark", role: "USER" } });
  userId = user.id;
  const { sessionId } = await createSession(user.id, {});
  const session = (await getSession(sessionId))!;
  await prisma.minecraftAccount.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ name: prefix + i, serverHost: "localhost" })) });
  const fixtures = await prisma.minecraftAccount.findMany({ where: { name: { startsWith: prefix } }, select: { id: true } });
  await prisma.userMinecraftAccount.createMany({ data: fixtures.map(({ id }) => ({ userId: user.id, minecraftAccountId: id })) });
  const now = Date.now();
  await prisma.consoleLog.createMany({ data: Array.from({ length: 20_000 }, (_, i) => ({
    minecraftAccountId: account.id, type: "CHAT" as const, message: `fixture ${i}`, createdAt: new Date(now - (20_000 - i) * 1000),
  })) });
  for (let offset = 0; offset < 100_000; offset += 10_000) {
    await prisma.sellEarning.createMany({ data: Array.from({ length: 10_000 }, (_, i) => ({
      minecraftAccountId: account.id, amount: 1071.01, createdAt: new Date(now - (offset + i) * 800),
    })) });
  }
  const report = {
    fixture: { logs: 20_000, sales: 100_000, accounts: 100 },
    dashboardPayloadBytes: Buffer.byteLength(JSON.stringify(await listDashboardAccountsForSession(session))),
    fullPayloadBytes: Buffer.byteLength(JSON.stringify(await listAccountsForSession(session))),
    accounts100Dashboard: await measure(() => listDashboardAccountsForSession(session), 20),
    accounts100: await measure(() => listAccountsForSession(session), 20),
    session: await measure(() => getSession(sessionId), 20),
    graph24hCold: await measure(() => { invalidateEarningsHistory(account.id); return getEarningsHistory(account.id, "24h", now); }, 8),
    graph24h: await measure(() => getEarningsHistory(account.id, "24h", now), 8),
    earnings: await measure(() => getEarningsSummary(account.id), 8),
    history2000: await measure(() => getConsoleLogs(account.id), 20),
    logWriteAtCapacity: await measure(() => persistConsoleLog(account.id, "SYSTEM", "benchmark append"), 50),
    retainedLogs: await prisma.consoleLog.count({ where: { minecraftAccountId: account.id } }),
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await prisma.minecraftAccount.deleteMany({ where: { name: { startsWith: prefix } } });
  if (userId) await prisma.user.delete({ where: { id: userId } });
  if (accountId) await prisma.minecraftAccount.delete({ where: { id: accountId } });
  await prisma.$disconnect();
}
