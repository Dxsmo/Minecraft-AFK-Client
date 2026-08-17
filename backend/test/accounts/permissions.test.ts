import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../src/database/prisma.js";
import { hashPassword } from "../../src/auth/password.js";
import {
  listAccountsForSession,
  canAccessAccount,
  setAssignments,
} from "../../src/accounts/service.js";
import type { SessionContext } from "../../src/auth/session.js";

function toSession(user: { id: string; username: string; role: "ADMIN" | "USER"; status: "ACTIVE" | "DISABLED" }): SessionContext {
  return { sessionId: "irrelevant", csrfToken: "irrelevant", user };
}

describe("account assignment permissions", () => {
  beforeEach(async () => {
    await prisma.userMinecraftAccount.deleteMany();
    await prisma.minecraftAccount.deleteMany();
    await prisma.user.deleteMany();
  });

  it("admin sees every account regardless of assignment", async () => {
    const admin = await prisma.user.create({
      data: { username: "admin-perm", passwordHash: await hashPassword("x"), role: "ADMIN" },
    });
    await prisma.minecraftAccount.create({ data: { name: "Bot_A", serverHost: "h", serverPort: 25565 } });
    await prisma.minecraftAccount.create({ data: { name: "Bot_B", serverHost: "h", serverPort: 25565 } });

    const accounts = await listAccountsForSession(toSession(admin as any));
    expect(accounts.map((a) => a.name).sort()).toEqual(["Bot_A", "Bot_B"]);
  });

  it("a normal user only sees accounts explicitly assigned to them", async () => {
    const user1 = await prisma.user.create({
      data: { username: "user1-perm", passwordHash: await hashPassword("x"), role: "USER" },
    });
    await prisma.user.create({
      data: { username: "user2-perm", passwordHash: await hashPassword("x"), role: "USER" },
    });
    const botA = await prisma.minecraftAccount.create({ data: { name: "Bot_C", serverHost: "h", serverPort: 25565 } });
    await prisma.minecraftAccount.create({ data: { name: "Bot_D", serverHost: "h", serverPort: 25565 } });

    await setAssignments(botA.id, [user1.id]);

    const accounts = await listAccountsForSession(toSession(user1 as any));
    expect(accounts.map((a) => a.name)).toEqual(["Bot_C"]);
  });

  it("canAccessAccount is false for unassigned users and true for assigned/admin", async () => {
    const admin = await prisma.user.create({
      data: { username: "admin-perm-2", passwordHash: await hashPassword("x"), role: "ADMIN" },
    });
    const user = await prisma.user.create({
      data: { username: "user-perm-2", passwordHash: await hashPassword("x"), role: "USER" },
    });
    const account = await prisma.minecraftAccount.create({ data: { name: "Bot_E", serverHost: "h", serverPort: 25565 } });

    expect(await canAccessAccount(toSession(admin as any), account.id)).toBe(true);
    expect(await canAccessAccount(toSession(user as any), account.id)).toBe(false);

    await setAssignments(account.id, [user.id]);
    expect(await canAccessAccount(toSession(user as any), account.id)).toBe(true);
  });
});
