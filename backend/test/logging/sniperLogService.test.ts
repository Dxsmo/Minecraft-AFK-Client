import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/database/prisma.js";
import { persistSniperLog, getSniperLogs } from "../../src/logging/sniperLogService.js";

const ids: string[] = [];
afterEach(async () => { await prisma.sniperAccount.deleteMany({ where: { id: { in: ids.splice(0) } } }); });
it("keeps exactly 2,000 sniper logs, deterministically handles tied times and isolates accounts", async () => {
  for (let i = 0; i < 2; i++) ids.push((await prisma.sniperAccount.create({ data: { email: `log-${randomUUID()}@example.com` } })).id);
  const timestamp = new Date(Date.now() - 10000);
  await prisma.sniperLog.createMany({ data: Array.from({ length: 2000 }, (_, i) => ({
    id: `sniper-${String(i).padStart(4, "0")}-${ids[0]}`, sniperAccountId: ids[0], type: "CHAT" as const, message: String(i), createdAt: timestamp,
  })) });
  await persistSniperLog(ids[1], "SYSTEM", "other");
  await persistSniperLog(ids[0], "SYSTEM", "latest");
  expect(await prisma.sniperLog.count({ where: { sniperAccountId: ids[0] } })).toBe(2000);
  expect((await getSniperLogs(ids[0], 2)).map(log => log.message)).toEqual(["1999", "latest"]);
  expect(await getSniperLogs(ids[1])).toEqual([expect.objectContaining({ message: "other" })]);
});
