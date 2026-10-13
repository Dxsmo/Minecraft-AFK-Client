import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { prisma } from "../../src/database/prisma.js";
import { createSession } from "../../src/auth/session.js";
import { config } from "../../src/config/config.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let users: { id: string; username: string; role: "ADMIN" | "USER"; status: "ACTIVE" | "DISABLED" }[];
let accounts: { id: string; name: string; dashboardOrder: number }[];
let sessions: { sessionId: string; csrfToken: string }[];
const headers = (index = 0, csrf = true) => ({ cookie: `${config.session.cookieName}=${sessions[index].sessionId}`,
  ...(csrf ? { "x-csrf-token": sessions[index].csrfToken } : {}) });
const read = (index = 0) => app.inject({ url: "/api/profile/dashboard", headers: headers(index) });
const patch = (payload: unknown, index = 0) => app.inject({ method: "PATCH", url: "/api/profile/dashboard", headers: headers(index), payload });
const empty = { accountOrder: [], blurredAccountIds: [], uploaderOrder: [], collapsedUploaderIds: [] };

beforeAll(async () => { app = await buildApp(); });
beforeEach(async () => {
  await prisma.minecraftAccount.deleteMany();
  await prisma.user.deleteMany();
  users = []; accounts = []; sessions = [];
  for (const [index, role] of (["USER", "USER", "ADMIN", "ADMIN"] as const).entries()) {
    const user = await prisma.user.create({ data: { username: `profile-${index}`, passwordHash: "test", role } });
    users.push(user); sessions.push(await createSession(user.id, {}));
  }
  for (let index = 0; index < 3; index++) {
    const account = await prisma.minecraftAccount.create({ data: { name: `Profile_${index}`, serverHost: "localhost", dashboardOrder: index,
      createdById: users[index % 2].id } });
    accounts.push(account);
    await prisma.userMinecraftAccount.createMany({ data: [0, 1].filter(user => index < 2 || user === 1)
      .map(user => ({ userId: users[user].id, minecraftAccountId: account.id })) });
  }
});
afterAll(async () => { await app?.close(); });

describe("personal dashboard profiles", () => {
  it("requires authentication and CSRF, rejects changing the profile owner", async () => {
    for (const method of ["GET", "PATCH", "POST"] as const) {
      const url = method === "POST" ? "/api/profile/dashboard/import" : "/api/profile/dashboard";
      expect((await app.inject({ method, url, ...(method !== "GET" ? { payload: {} } : {}) })).statusCode).toBe(401);
      if (method !== "GET") expect((await app.inject({ method, url, headers: headers(0, false), payload: {} })).statusCode).toBe(403);
    }
    expect((await patch({ userId: users[1].id, blur: { accountId: accounts[0].id, value: true } })).statusCode).toBe(400);
    const switched = await app.inject({ method: "PATCH", url: "/api/profile/dashboard", headers: { ...headers(1), "x-profile-owner": users[0].id },
      payload: { blur: { accountId: accounts[0].id, value: true } } });
    expect(switched.statusCode).toBe(409);
    expect((await read(1)).json().preferences).toEqual(empty);
    expect((await patch({ accountOrder: [accounts[0].id, accounts[0].id] })).statusCode).toBe(400);
    expect((await patch({ blur: { accountId: accounts[2].id, value: true } })).statusCode).toBe(404);
    expect((await patch({ uploaderOrder: [] })).statusCode).toBe(403);
    expect((await patch({ collapse: { uploaderId: `user:${users[1].id}`, value: true } })).statusCode).toBe(403);
    expect((await read()).headers["cache-control"]).toBe("private, no-store");
    expect((await read()).json()).toEqual({ initialized: false, preferences: empty });
  });

  it("restores blur and ordering through a second session without changing another user's order", async () => {
    const order = [accounts[1].id, accounts[0].id];
    expect((await app.inject({ method: "PUT", url: "/api/minecraft/accounts/reorder", headers: headers(), payload: { accountIds: order } })).statusCode).toBe(200);
    expect((await patch({ blur: { accountId: accounts[0].id, value: true } })).statusCode).toBe(200);
    const secondDevice = await createSession(users[0].id, { userAgent: "second-device" });
    const restored = await app.inject({ url: "/api/profile/dashboard", headers: { cookie: `${config.session.cookieName}=${secondDevice.sessionId}` } });
    expect(restored.json().preferences).toEqual({ ...empty, accountOrder: order, blurredAccountIds: [accounts[0].id] });
    for (const view of ["full", "dashboard"]) {
      const list = (index: number) => app.inject({ url: `/api/minecraft/accounts?view=${view}`, headers: headers(index) });
      expect((await list(0)).json().map((row: { id: string }) => row.id)).toEqual(order);
      expect((await list(1)).json().map((row: { id: string }) => row.id)).toEqual(accounts.map(account => account.id));
    }
    expect((await read(1)).json().preferences).toEqual(empty);
    expect((await prisma.minecraftAccount.findMany({ orderBy: { dashboardOrder: "asc" }, select: { id: true, dashboardOrder: true } }))
      .map(row => row.dashboardOrder)).toEqual([0, 1, 2]);
  });

  it("keeps admin categories and account orders private and permits atomic edits from separate devices", async () => {
    const uploaderOrder = users.map(user => `user:${user.id}`).reverse();
    const accountOrder = accounts.map(account => account.id).reverse();
    expect((await patch({ uploaderOrder, accountOrder }, 2)).statusCode).toBe(200);
    expect((await patch({ collapse: { uploaderId: uploaderOrder[0], value: true } }, 2)).statusCode).toBe(200);
    // Device two has an old snapshot but only changes the requested membership.
    expect((await patch({ blur: { accountId: accounts[0].id, value: true } }, 2)).statusCode).toBe(200);
    const secondDevice = await createSession(users[2].id, {});
    expect((await app.inject({ method: "PATCH", url: "/api/profile/dashboard", payload: { blur: { accountId: accounts[1].id, value: true } },
      headers: { cookie: `${config.session.cookieName}=${secondDevice.sessionId}`, "x-csrf-token": secondDevice.csrfToken } })).statusCode).toBe(200);
    expect((await read(2)).json().preferences).toEqual({ accountOrder, uploaderOrder,
      collapsedUploaderIds: [uploaderOrder[0]], blurredAccountIds: [accounts[0].id, accounts[1].id] });
    expect((await read(3)).json().preferences).toEqual(empty);
    expect((await patch({ uploaderOrder: ["user:missing"] }, 2)).statusCode).toBe(400);
  });

  it("imports old settings once, filters stale IDs and never overwrites a saved profile", async () => {
    const payload = { ...empty, blurredAccountIds: [accounts[0].id, accounts[2].id, "deleted"], uploaderOrder: [`user:${users[1].id}`] };
    const imported = await app.inject({ method: "POST", url: "/api/profile/dashboard/import", headers: headers(), payload });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toEqual({ initialized: true, preferences: { ...empty, blurredAccountIds: [accounts[0].id] } });
    await patch({ blur: { accountId: accounts[1].id, value: true } });
    const again = await app.inject({ method: "POST", url: "/api/profile/dashboard/import", headers: headers(), payload: empty });
    expect(again.json().preferences.blurredAccountIds).toEqual([accounts[0].id, accounts[1].id]);
  });

  it("hides revoked account IDs and admin categories after demotion without destroying saved preferences", async () => {
    expect((await patch({ accountOrder: accounts.map(account => account.id).reverse(), blur: { accountId: accounts[0].id, value: true } })).statusCode).toBe(400);
    expect((await read()).json().preferences.blurredAccountIds).toEqual([]);
    // The full order fails for a normal user, so save a valid visible order first.
    await patch({ accountOrder: [accounts[1].id, accounts[0].id], blur: { accountId: accounts[0].id, value: true } });
    await prisma.userMinecraftAccount.deleteMany({ where: { userId: users[0].id, minecraftAccountId: accounts[0].id } });
    const response = await read();
    expect(response.body).not.toContain(accounts[0].id);
    await patch({ accountOrder: [accounts[1].id] });
    await prisma.userMinecraftAccount.create({ data: { userId: users[0].id, minecraftAccountId: accounts[0].id } });
    expect((await read()).json().preferences.blurredAccountIds).toEqual([accounts[0].id]);
    await patch({ uploaderOrder: [`user:${users[1].id}`], collapse: { uploaderId: `user:${users[1].id}`, value: true } }, 2);
    await prisma.user.update({ where: { id: users[2].id }, data: { role: "USER" } });
    const demoted = await read(2);
    expect(demoted.json().preferences.uploaderOrder).toEqual([]);
    expect(demoted.json().preferences.collapsedUploaderIds).toEqual([]);
  });
});
