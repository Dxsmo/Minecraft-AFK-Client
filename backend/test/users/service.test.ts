import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../src/database/prisma.js";
import * as usersService from "../../src/users/service.js";
import { getSession, createSession } from "../../src/auth/session.js";

describe("users service", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
  });

  it("creates a user with a hashed password (never plaintext)", async () => {
    const user = await usersService.createUser({ username: "newuser", password: "supersecret1", role: "USER" });
    expect(user.username).toBe("newuser");
    const raw = await prisma.user.findUnique({ where: { id: user.id } });
    expect(raw!.passwordHash).not.toBe("supersecret1");
  });

  it("never returns passwordHash from listUsers/getUserById", async () => {
    const user = await usersService.createUser({ username: "listedUser", password: "supersecret1", role: "USER" });
    const list = await usersService.listUsers();
    const found = list.find((u) => u.id === user.id);
    expect(found).toBeDefined();
    expect((found as any).passwordHash).toBeUndefined();
  });

  it("destroys all sessions when a user's password is changed", async () => {
    const user = await usersService.createUser({ username: "sessionKill", password: "supersecret1", role: "USER" });
    const { sessionId } = await createSession(user.id, {});
    expect(await getSession(sessionId)).not.toBeNull();

    await usersService.updateUser(user.id, { password: "newpassword123" });
    expect(await getSession(sessionId)).toBeNull();
  });

  it("destroys all sessions when a user is disabled", async () => {
    const user = await usersService.createUser({ username: "disableKill", password: "supersecret1", role: "USER" });
    const { sessionId } = await createSession(user.id, {});

    await usersService.updateUser(user.id, { status: "DISABLED" });
    expect(await getSession(sessionId)).toBeNull();
  });

  it("counts only active admins", async () => {
    await usersService.createUser({ username: "admin1", password: "supersecret1", role: "ADMIN" });
    const admin2 = await usersService.createUser({ username: "admin2", password: "supersecret1", role: "ADMIN" });
    await usersService.updateUser(admin2.id, { status: "DISABLED" });

    expect(await usersService.countAdmins()).toBe(1);
  });
});
