import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../src/database/prisma.js";
import { hashPassword } from "../../src/auth/password.js";
import { createSession, getSession, destroySession, destroyAllUserSessions } from "../../src/auth/session.js";

async function makeUser(username: string, role: "ADMIN" | "USER" = "USER") {
  return prisma.user.create({
    data: { username, passwordHash: await hashPassword("password123"), role },
  });
}

describe("session service", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
  });

  it("creates a session and can retrieve it", async () => {
    const user = await makeUser("session-user-1");
    const { sessionId, csrfToken } = await createSession(user.id, {});

    const session = await getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.user.username).toBe("session-user-1");
    expect(session!.csrfToken).toBe(csrfToken);
  });

  it("returns null for an unknown session id", async () => {
    const session = await getSession("does-not-exist");
    expect(session).toBeNull();
  });

  it("returns null once the session has been destroyed", async () => {
    const user = await makeUser("session-user-2");
    const { sessionId } = await createSession(user.id, {});
    await destroySession(sessionId);
    expect(await getSession(sessionId)).toBeNull();
  });

  it("returns null for sessions belonging to a disabled user", async () => {
    const user = await makeUser("session-user-3");
    const { sessionId } = await createSession(user.id, {});
    await prisma.user.update({ where: { id: user.id }, data: { status: "DISABLED" } });
    expect(await getSession(sessionId)).toBeNull();
  });

  it("destroys all sessions for a user", async () => {
    const user = await makeUser("session-user-4");
    const s1 = await createSession(user.id, {});
    const s2 = await createSession(user.id, {});
    await destroyAllUserSessions(user.id);
    expect(await getSession(s1.sessionId)).toBeNull();
    expect(await getSession(s2.sessionId)).toBeNull();
  });
});
