import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/database/prisma.js";
import { getConsoleLogs, MAX_LOGS_PER_ACCOUNT, persistConsoleLog } from "../../src/logging/consoleLogService.js";

const accountIds: string[] = [];
async function account() {
  const row = await prisma.minecraftAccount.create({ data: { name: `LogBot-${randomUUID()}`, serverHost: "localhost" } });
  accountIds.push(row.id);
  return row.id;
}
afterEach(async () => {
  await prisma.minecraftAccount.deleteMany({ where: { id: { in: accountIds.splice(0) } } });
});

describe("console history", () => {
  it("paginates tied timestamps without duplicates and scopes cursors to the account", async () => {
    const id = await account();
    const other = await account();
    const createdAt = new Date("2026-10-05T10:00:00Z");
    await prisma.consoleLog.createMany({ data: [
      ...["a", "b", "c", "d", "e"].map((suffix) => ({
        id: `log-${suffix}`, minecraftAccountId: id, type: "CHAT" as const, message: suffix, createdAt,
      })),
      { id: "foreign-log", minecraftAccountId: other, type: "CHAT", message: "private", createdAt },
    ] });
    const newest = await getConsoleLogs(id, 2);
    expect(newest.map((log) => log.message)).toEqual(["d", "e"]);
    const older = await getConsoleLogs(id, 2, newest[0].id);
    expect(older.map((log) => log.message)).toEqual(["b", "c"]);
    expect((await getConsoleLogs(id, 2, older[0].id)).map((log) => log.message)).toEqual(["a"]);
    expect(await getConsoleLogs(id, 2, "foreign-log")).toEqual([]);
    expect(await getConsoleLogs(id, 2, "missing-log")).toEqual([]);
    expect(await getConsoleLogs(id, Number.NaN)).toHaveLength(5);
    expect(await getConsoleLogs(id, 0)).toHaveLength(1);
  });

  it("keeps 20,000 lines and prunes only the oldest lines of the current account", async () => {
    const id = await account();
    const other = await account();
    const start = Date.now() - MAX_LOGS_PER_ACCOUNT * 1000;
    await prisma.consoleLog.createMany({ data: Array.from({ length: MAX_LOGS_PER_ACCOUNT }, (_, i) => ({
      minecraftAccountId: id, type: "CHAT" as const, message: `line ${i}`, createdAt: new Date(start + i * 1000),
    })) });
    await persistConsoleLog(other, "CHAT", "other account");
    await persistConsoleLog(id, "SYSTEM", "newest");
    expect(await prisma.consoleLog.count({ where: { minecraftAccountId: id } })).toBe(20_000);
    expect(await prisma.consoleLog.findFirst({ where: { minecraftAccountId: id, message: "line 0" } })).toBeNull();
    expect(await getConsoleLogs(id, 1)).toEqual([expect.objectContaining({ message: "newest" })]);
    expect(await getConsoleLogs(id, 10_000)).toHaveLength(2000);
    expect(await getConsoleLogs(other)).toEqual([expect.objectContaining({ message: "other account" })]);
  });
});
