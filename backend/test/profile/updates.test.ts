import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { prisma } from "../../src/database/prisma.js";
import { createSession } from "../../src/auth/session.js";
import { config } from "../../src/config/config.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let users: { id: string }[];
let sessions: { sessionId: string; csrfToken: string }[];
const headers = (index = 0) => ({ cookie: `${config.session.cookieName}=${sessions[index].sessionId}`,
  "x-csrf-token": sessions[index].csrfToken, "x-profile-owner": users[index].id });
const get = (index = 0) => app.inject({ url: "/api/profile/updates", headers: headers(index) });
const read = (announcementId: string, index = 0) => app.inject({ method: "PATCH", url: "/api/profile/updates/read",
  headers: headers(index), payload: { announcementId } });

beforeAll(async () => { app = await buildApp(); });
beforeEach(async () => {
  await prisma.minecraftAccount.deleteMany(); await prisma.user.deleteMany();
  users = []; sessions = [];
  for (const role of ["USER", "ADMIN"] as const) {
    const user = await prisma.user.create({ data: { username: `updates-${role}`, role, passwordHash: "test" } });
    users.push(user); sessions.push(await createSession(user.id, {}));
  }
});
afterAll(async () => { await app?.close(); });

describe("explicit website announcements", () => {
  it("starts unread for every user, and reading status never acknowledges the announcement", async () => {
    for (const index of [0, 1]) {
      const response = await get(index);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json().unread).toBe(true);
      expect(response.json().announcement.items).toHaveLength(5);
      expect((await get(index)).json().unread).toBe(true);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: users[index].id } })).lastSeenWebsiteUpdate).toBeNull();
    }
  });

  it("persists opening across devices and logins, without affecting other users or dashboard preferences", async () => {
    const id = (await get()).json().announcement.id;
    await prisma.user.update({ where: { id: users[0].id }, data: { dashboardPreferences: "{}" } });
    expect((await read(id)).json().unread).toBe(false);
    expect((await read(id)).statusCode).toBe(200);
    const secondDevice = await createSession(users[0].id, {});
    expect((await app.inject({ url: "/api/profile/updates",
      headers: { cookie: `${config.session.cookieName}=${secondDevice.sessionId}` } })).json().unread).toBe(false);
    expect((await get(1)).json().unread).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: users[0].id } })).dashboardPreferences).toBe("{}");
  });

  it("only acknowledges the displayed announcement; stale or unknown IDs cannot hide a new update", async () => {
    await prisma.user.update({ where: { id: users[0].id }, data: { lastSeenWebsiteUpdate: "older-explicit-announcement" } });
    expect((await get()).json().unread).toBe(true);
    expect((await read("older-explicit-announcement")).statusCode).toBe(409);
    expect((await read("arbitrary-future-version")).statusCode).toBe(409);
    expect((await get()).json().unread).toBe(true);
    const id = (await get()).json().announcement.id;
    await read(id);
    // Normal backend restarts do not create a new ID or reset the marker.
    await app.close(); app = await buildApp();
    expect((await get()).json().unread).toBe(false);
    expect((await get()).json().announcement.id).toBe(id);
  });

  it("requires authentication, CSRF and the original profile owner for writes", async () => {
    const id = (await get()).json().announcement.id;
    expect((await app.inject({ url: "/api/profile/updates" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PATCH", url: "/api/profile/updates/read", payload: { announcementId: id } })).statusCode).toBe(401);
    expect((await app.inject({ method: "PATCH", url: "/api/profile/updates/read", headers: { cookie: headers().cookie },
      payload: { announcementId: id } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: "/api/profile/updates/read", headers: { ...headers(1), "x-profile-owner": users[0].id },
      payload: { announcementId: id } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PATCH", url: "/api/profile/updates/read", headers: headers(),
      payload: { announcementId: id, userId: users[1].id } })).statusCode).toBe(400);
    expect((await get()).json().unread).toBe(true);
    expect((await get(1)).json().unread).toBe(true);
  });
});
