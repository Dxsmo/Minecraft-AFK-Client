import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../src/app.js";
import { prisma } from "../../src/database/prisma.js";
import { createSession } from "../../src/auth/session.js";
import { config } from "../../src/config/config.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let accountId: string;
const users: string[] = [];
const cookies: string[] = [];

beforeAll(async () => {
  for (const role of ["ADMIN", "USER", "USER"] as const) {
    const user = await prisma.user.create({ data: { username: `graph-${randomUUID()}`, passwordHash: "test", role } });
    users.push(user.id);
    const session = await createSession(user.id, {});
    cookies.push(`${config.session.cookieName}=${session.sessionId}`);
  }
  const account = await prisma.minecraftAccount.create({ data: {
    name: `Graph_${randomUUID()}`, serverHost: "localhost", assignments: { create: { userId: users[1] } },
  } });
  accountId = account.id;
  await prisma.sellEarning.create({ data: { minecraftAccountId: accountId, amount: 42,
    createdAt: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 1000) } });
  app = await buildApp();
});
afterAll(async () => {
  await app?.close();
  if (accountId) await prisma.minecraftAccount.delete({ where: { id: accountId } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
});

it("exposes the graph only to admins and users assigned to the account", async () => {
  const url = `/api/minecraft/accounts/${accountId}/earnings/history?range=6h`;
  expect((await app.inject({ url })).statusCode).toBe(401);
  for (const cookie of cookies.slice(0, 2)) {
    const response = await app.inject({ url, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ range: "6h", total: 42 });
    expect(response.json().points).toHaveLength(72);
  }
  const response = await app.inject({ url, headers: { cookie: cookies[2] } });
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ error: "Account not found" });
});

it("defaults to one hour and rejects unsupported or repeated ranges", async () => {
  const base = `/api/minecraft/accounts/${accountId}/earnings/history`;
  const headers = { cookie: cookies[1] };
  expect((await app.inject({ url: base, headers })).json().range).toBe("1h");
  for (const suffix of ["?range=7d", "?range=1h&range=24h", "?range=24h&accountId=other"]) {
    expect((await app.inject({ url: base + suffix, headers })).statusCode).toBe(400);
  }
});
