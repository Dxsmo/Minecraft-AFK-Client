import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../src/app.js";
import { prisma } from "../../src/database/prisma.js";
import { createSession } from "../../src/auth/session.js";
import { config } from "../../src/config/config.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let accountId: string;
const users: string[] = [];
const sessions: { role: string; cookie: string; csrf: string }[] = [];

beforeAll(async () => {
  for (const role of ["ADMIN", "USER"] as const) {
    const user = await prisma.user.create({
      data: { username: `inventory-${randomUUID().slice(0, 8)}`, passwordHash: "test", role },
    });
    users.push(user.id);
    const session = await createSession(user.id, {});
    sessions.push({ role, cookie: `${config.session.cookieName}=${session.sessionId}`, csrf: session.csrfToken });
  }
  const account = await prisma.minecraftAccount.create({
    data: {
      name: `Bot_${randomUUID().slice(0, 8)}`, serverHost: "localhost", serverPort: 25565,
      assignments: { create: users.map((userId) => ({ userId })) },
    },
  });
  accountId = account.id;
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
  if (accountId) await prisma.minecraftAccount.delete({ where: { id: accountId } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
});

it("removes inventory viewing, moving and dropping for admins and assigned users", async () => {
  for (const session of sessions) {
    const headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
    // Verify that the authenticated user can still access the account itself.
    expect((await app.inject({ url: `/api/minecraft/accounts/${accountId}`, headers })).statusCode).toBe(200);
    for (const [method, suffix, payload] of [
      ["GET", "inventory", undefined],
      ["POST", "inventory/move", { from: 9, to: 10 }],
      ["POST", "inventory/drop", { slot: 9 }],
    ] as const) {
      const response = await app.inject({
        method, url: `/api/minecraft/accounts/${accountId}/${suffix}`, headers, payload,
      });
      expect(response.statusCode, `${session.role}: ${suffix}`).toBe(404);
    }
  }
});
