import { performance } from "node:perf_hooks";
import { prisma } from "../src/database/prisma.js";
import { persistConsoleLog } from "../src/logging/consoleLogService.js";
import { buildApp } from "../src/app.js";
import { createSession } from "../src/auth/session.js";
import { config } from "../src/config/config.js";

if (process.env.NODE_ENV !== "test" || !process.env.DATABASE_URL?.endsWith("contention-performance.db")) {
  throw new Error("Use NODE_ENV=test and an isolated contention-performance.db.");
}
const prefix = `Contention-${Date.now()}`;
const accounts: string[] = [];
let userId: string | undefined;
const app = await buildApp();
try {
  // Clean up only this benchmark's abandoned fixtures in its dedicated DB.
  await prisma.minecraftAccount.deleteMany({ where: { name: { startsWith: "Contention-" } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: "Contention-" } } });
  const user = await prisma.user.create({ data: { username: prefix, passwordHash: "fixture", role: "ADMIN" } });
  userId = user.id;
  const { sessionId } = await createSession(user.id, {});
  for (let i = 0; i < 10; i++) {
    const account = await prisma.minecraftAccount.create({ data: { name: `${prefix}-${i}`, serverHost: "localhost" } });
    accounts.push(account.id);
    const now = Date.now();
    await prisma.consoleLog.createMany({ data: Array.from({ length: 20_000 }, (_, j) => ({
      minecraftAccountId: account.id, type: "CHAT", message: `fixture ${j}`, createdAt: new Date(now - 20_000 + j),
    })) });
  }
  async function unbuffered(accountId: string, message: string) {
    await prisma.$transaction([
      prisma.consoleLog.create({ data: { minecraftAccountId: accountId, type: "CHAT", message } }),
      prisma.$executeRaw`DELETE FROM "ConsoleLog" WHERE "minecraftAccountId" = ${accountId}
        AND ("createdAt", "id") < (SELECT "createdAt", "id" FROM "ConsoleLog"
        WHERE "minecraftAccountId" = ${accountId} ORDER BY "createdAt" DESC, "id" DESC LIMIT 1 OFFSET 19999)`,
    ]);
  }
  async function scenario(buffered: boolean) {
    const start = performance.now();
    const messagePrefix = buffered ? "buffered burst " : "unbuffered burst ";
    const writes = Promise.allSettled(Array.from({ length: 2000 }, (_, i) => buffered
      ? persistConsoleLog(accounts[i % accounts.length], "CHAT", `${messagePrefix}${i}`)
      : unbuffered(accounts[i % accounts.length], `${messagePrefix}${i}`)));
    // Submit reads after the write burst, as when opening the site on an active host.
    const reads = await Promise.all(Array.from({ length: 20 }, async () => {
      const readStart = performance.now();
      const response = await app.inject({ method: "GET", url: "/api/minecraft/accounts?view=dashboard",
        headers: { cookie: `${config.session.cookieName}=${sessionId}` } });
      return { durationMs: performance.now() - readStart, status: response.statusCode };
    }));
    const results = await writes;
    const burstMs = performance.now() - start;
    const persistedBurstLogs = await prisma.consoleLog.count({ where: {
      minecraftAccountId: { in: accounts }, message: { startsWith: messagePrefix },
    } });
    if (buffered && persistedBurstLogs !== 2000) throw new Error("Buffered logs were lost");
    reads.sort((a, b) => a.durationMs - b.durationMs);
    return { totalBurstMs: +burstMs.toFixed(2), persistedBurstLogs,
      accountRequestMedianMs: +reads[10].durationMs.toFixed(2), accountRequestP95Ms: +reads[19].durationMs.toFixed(2),
      failedWrites: results.filter(result => result.status === "rejected").length,
      failedReads: reads.filter(result => result.status !== 200).length };
  }
  console.log(JSON.stringify({ fixture: { accounts: 10, existingLogs: 200_000, burstLogs: 2000, concurrentAccountRequests: 20 },
    unbuffered: await scenario(false), buffered: await scenario(true) }, null, 2));
} finally {
  await app.close();
  await prisma.minecraftAccount.deleteMany({ where: { id: { in: accounts } } });
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
}
