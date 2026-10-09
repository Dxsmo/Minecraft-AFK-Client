import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../src/app.js";
import { prisma } from "../../src/database/prisma.js";
import { createSession, getSession } from "../../src/auth/session.js";
import { config } from "../../src/config/config.js";
import { getMinecraftAvatar } from "../../src/users/minecraftAvatar.js";
import { createUserSchema, updateUserSchema } from "../../src/users/schemas.js";

vi.mock("../../src/users/minecraftAvatar.js", () => ({ getMinecraftAvatar: vi.fn() }));

let app: Awaited<ReturnType<typeof buildApp>>;
let accountId: string;
const users: string[] = [];
const sessions: Awaited<ReturnType<typeof createSession>>[] = [];
const cookie = (index: number) => `${config.session.cookieName}=${sessions[index].sessionId}`;
const headers = (index: number) => ({ cookie: cookie(index), "x-csrf-token": sessions[index].csrfToken });

beforeAll(async () => {
  for (const role of ["ADMIN", "USER", "USER"] as const) {
    const user = await prisma.user.create({ data: { username: `creator-${randomUUID()}`, passwordHash: "private-hash", role } });
    users.push(user.id);
    sessions.push(await createSession(user.id, {}));
  }
  const account = await prisma.minecraftAccount.create({ data: {
    name: `Creator_${randomUUID()}`, serverHost: "localhost", createdById: users[1],
    assignments: { create: { userId: users[2] } },
  } });
  accountId = account.id;
  app = await buildApp();
});
beforeEach(() => vi.mocked(getMinecraftAvatar).mockReset());
afterAll(async () => {
  await app?.close();
  if (accountId) await prisma.minecraftAccount.delete({ where: { id: accountId } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
});

it("validates Minecraft names, preserves their spelling and supports clearing the assignment", () => {
  expect(updateUserSchema.parse({ minecraftUsername: " Desmodus " }).minecraftUsername).toBe("Desmodus");
  for (const minecraftUsername of [null, "", "   "]) {
    expect(updateUserSchema.parse({ minecraftUsername }).minecraftUsername).toBeNull();
  }
  expect(updateUserSchema.parse({})).not.toHaveProperty("minecraftUsername");
  for (const minecraftUsername of ["ab", "a".repeat(17), "../admin", "Name?url", "some name", "Äpfel", 12]) {
    expect(updateUserSchema.safeParse({ minecraftUsername }).success).toBe(false);
  }
  expect(createUserSchema.parse({ username: "new-user", password: "test-password", minecraftUsername: "Alex_123" })
    .minecraftUsername).toBe("Alex_123");
});

it("only permits admins with CSRF protection to assign a Minecraft name", async () => {
  const url = `/api/users/${users[1]}`;
  const payload = { minecraftUsername: "Desmodus" };
  expect((await app.inject({ method: "PATCH", url, payload })).statusCode).toBe(401);
  expect((await app.inject({ method: "PATCH", url, payload, headers: headers(1) })).statusCode).toBe(403);
  expect((await app.inject({ method: "PATCH", url, payload, headers: { cookie: cookie(0) } })).statusCode).toBe(403);
  const response = await app.inject({ method: "PATCH", url, payload, headers: headers(0) });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ id: users[1], minecraftUsername: "Desmodus" });
  expect(response.json()).not.toHaveProperty("passwordHash");
  expect(await getSession(sessions[1].sessionId)).not.toBeNull();
  expect((await app.inject({ method: "PATCH", url, payload: { minecraftUsername: "../invalid" }, headers: headers(0) })).statusCode).toBe(400);
  expect((await app.inject({ url: "/api/users", headers: headers(1) })).statusCode).toBe(403);
  const listing = await app.inject({ url: "/api/users", headers: headers(0) });
  expect(listing.json().find((user: { id: string }) => user.id === users[1]).minecraftUsername).toBe("Desmodus");
});

it("shows the original uploader's name to authorized viewers, never the assigned viewer's profile", async () => {
  await prisma.user.update({ where: { id: users[1] }, data: { minecraftUsername: "Desmodus" } });
  await prisma.user.update({ where: { id: users[2] }, data: { minecraftUsername: "OtherPlayer" } });
  for (const index of [0, 2]) {
    const response = await app.inject({ url: `/api/minecraft/accounts/${accountId}`, headers: headers(index) });
    expect(response.statusCode).toBe(200);
    expect(response.json().createdBy).toMatchObject({ id: users[1], minecraftUsername: "Desmodus" });
    expect(response.json().createdBy).not.toHaveProperty("passwordHash");
    const list = await app.inject({ url: "/api/minecraft/accounts", headers: headers(index) });
    expect(list.json().find((account: { id: string }) => account.id === accountId).createdBy.minecraftUsername).toBe("Desmodus");
  }
  expect((await app.inject({ url: `/api/minecraft/accounts/${accountId}`, headers: headers(1) })).statusCode).toBe(404);
});

it("checks account access before fetching or serving the creator's avatar", async () => {
  await prisma.user.update({ where: { id: users[1] }, data: { minecraftUsername: "Desmodus" } });
  const url = `/api/minecraft/accounts/${accountId}/creator-avatar`;
  expect((await app.inject({ url })).statusCode).toBe(401);
  expect((await app.inject({ url, headers: headers(1) })).statusCode).toBe(404);
  expect(getMinecraftAvatar).not.toHaveBeenCalled();
  vi.mocked(getMinecraftAvatar).mockResolvedValue(Buffer.from("verified-png"));
  for (const index of [0, 2]) {
    const response = await app.inject({ url, headers: headers(index) });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["cache-control"]).toBe("private, no-store");
  }
  expect(getMinecraftAvatar).toHaveBeenCalledWith("Desmodus");
  vi.mocked(getMinecraftAvatar).mockClear();
  // A formerly authorized user cannot read an already cached avatar after revocation.
  await prisma.userMinecraftAccount.deleteMany({ where: { minecraftAccountId: accountId } });
  expect((await app.inject({ url, headers: headers(2) })).statusCode).toBe(404);
  expect(getMinecraftAvatar).not.toHaveBeenCalled();
});

it("handles unavailable skins, unassigned names and deleted creators safely", async () => {
  const url = `/api/minecraft/accounts/${accountId}/creator-avatar`;
  vi.mocked(getMinecraftAvatar).mockResolvedValue(null);
  expect((await app.inject({ url, headers: headers(0) })).statusCode).toBe(502);
  const cleared = await app.inject({ method: "PATCH", url: `/api/users/${users[1]}`,
    payload: { minecraftUsername: "" }, headers: headers(0) });
  expect(cleared.statusCode).toBe(200);
  expect(cleared.json().minecraftUsername).toBeNull();
  vi.mocked(getMinecraftAvatar).mockClear();
  expect((await app.inject({ url, headers: headers(0) })).statusCode).toBe(404);
  expect(getMinecraftAvatar).not.toHaveBeenCalled();
  await prisma.user.delete({ where: { id: users[1] } });
  expect((await app.inject({ url, headers: headers(0) })).statusCode).toBe(404);
});
