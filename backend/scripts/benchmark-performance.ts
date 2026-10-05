import { performance } from "node:perf_hooks";
import { prisma } from "../src/database/prisma.js";
import { getEarningsSummary } from "../src/accounts/service.js";
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
try {
  const account = await prisma.minecraftAccount.create({ data: { name: `Perf-${Date.now()}`, serverHost: "localhost" } });
  accountId = account.id;
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
    fixture: { logs: 20_000, sales: 100_000 },
    earnings: await measure(() => getEarningsSummary(account.id), 8),
    history2000: await measure(() => getConsoleLogs(account.id), 20),
    logWriteAtCapacity: await measure(() => persistConsoleLog(account.id, "SYSTEM", "benchmark append"), 50),
    retainedLogs: await prisma.consoleLog.count({ where: { minecraftAccountId: account.id } }),
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (accountId) await prisma.minecraftAccount.delete({ where: { id: accountId } });
  await prisma.$disconnect();
}
