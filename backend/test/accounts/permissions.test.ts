import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../src/database/prisma.js";
import { hashPassword } from "../../src/auth/password.js";
import {
  listAccountsForSession,
  listDashboardAccountsForSession,
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

  it("loads small dashboard summaries with the same visibility and ordering as full accounts", async () => {
    const user = await prisma.user.create({ data: { username: "dashboard-perm", passwordHash: "test", role: "USER" } });
    const first = await prisma.minecraftAccount.create({ data: { name: "Dash_B", serverHost: "localhost", dashboardOrder: 0, createdById: user.id } });
    const second = await prisma.minecraftAccount.create({ data: { name: "Dash_A", serverHost: "localhost", dashboardOrder: 1 } });
    await prisma.minecraftAccount.create({ data: { name: "Hidden_Dash", serverHost: "localhost" } });
    await setAssignments(first.id, [user.id]);
    await setAssignments(second.id, [user.id]);
    const session = toSession(user);
    const summaries = await listDashboardAccountsForSession(session);
    expect(summaries.map(a => a.id)).toEqual((await listAccountsForSession(session)).map(a => a.id));
    expect(summaries[0]).toMatchObject({ name: "Dash_B", imageUrl: null, createdBy: { username: user.username } });
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty("assignments");
      expect(summary).not.toHaveProperty("credentialsSecret");
      expect(summary).not.toHaveProperty("spawnerActions");
    }
    await setAssignments(first.id, []);
    expect((await listDashboardAccountsForSession(session)).map(a => a.id)).toEqual([second.id]);
  });
});
