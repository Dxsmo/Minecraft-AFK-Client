import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/database/prisma.js";
import { hashPassword } from "../../src/auth/password.js";
import { setAssignments } from "../../src/accounts/service.js";
import type { SessionContext } from "../../src/auth/session.js";

const sendCommandMock = vi.fn();

vi.mock("../../src/minecraft/ClientManager.js", () => ({
  clientManager: {
    get: vi.fn((id: string) => (id === "online-account" ? { sendCommand: sendCommandMock } : undefined)),
  },
}));

const { executeCommand } = await import("../../src/commands/service.js");

function toSession(user: { id: string; username: string; role: "ADMIN" | "USER"; status: "ACTIVE" | "DISABLED" }): SessionContext {
  return { sessionId: "irrelevant", csrfToken: "irrelevant", user };
}

describe("command execution permission checks", () => {
  beforeEach(async () => {
    sendCommandMock.mockReset();
    await prisma.userMinecraftAccount.deleteMany();
    await prisma.minecraftAccount.deleteMany();
    await prisma.user.deleteMany();
  });

  it("rejects with FORBIDDEN when the user is not assigned to the account", async () => {
    const user = await prisma.user.create({
      data: { username: "cmd-user-1", passwordHash: await hashPassword("x"), role: "USER" },
    });
    const account = await prisma.minecraftAccount.create({
      data: { id: "online-account", name: "Bot_Cmd_1", serverHost: "h", serverPort: 25565 },
    });

    const result = await executeCommand(toSession(user as any), account.id, "/say hi");
    expect(result).toEqual({ ok: false, reason: "FORBIDDEN" });
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it("allows an assigned user to run a command and forwards it to the client", async () => {
    const user = await prisma.user.create({
      data: { username: "cmd-user-2", passwordHash: await hashPassword("x"), role: "USER" },
    });
    const account = await prisma.minecraftAccount.create({
      data: { id: "online-account", name: "Bot_Cmd_2", serverHost: "h", serverPort: 25565 },
    });
    await setAssignments(account.id, [user.id]);
    sendCommandMock.mockReturnValue(true);

    const result = await executeCommand(toSession(user as any), account.id, "/say hi");
    expect(result).toEqual({ ok: true });
    expect(sendCommandMock).toHaveBeenCalledWith("/say hi");
  });

  it("allows admin regardless of assignment", async () => {
    const admin = await prisma.user.create({
      data: { username: "cmd-admin", passwordHash: await hashPassword("x"), role: "ADMIN" },
    });
    await prisma.minecraftAccount.create({
      data: { id: "online-account", name: "Bot_Cmd_3", serverHost: "h", serverPort: 25565 },
    });
    sendCommandMock.mockReturnValue(true);

    const result = await executeCommand(toSession(admin as any), "online-account", "/say hi");
    expect(result).toEqual({ ok: true });
  });

  it("returns NOT_FOUND when the account has no running client", async () => {
    const admin = await prisma.user.create({
      data: { username: "cmd-admin-2", passwordHash: await hashPassword("x"), role: "ADMIN" },
    });
    await prisma.minecraftAccount.create({
      data: { id: "offline-account", name: "Bot_Cmd_4", serverHost: "h", serverPort: 25565 },
    });

    const result = await executeCommand(toSession(admin as any), "offline-account", "/say hi");
    expect(result).toEqual({ ok: false, reason: "NOT_FOUND" });
  });

  it("returns OFFLINE when the client rejects the command (not connected)", async () => {
    const admin = await prisma.user.create({
      data: { username: "cmd-admin-3", passwordHash: await hashPassword("x"), role: "ADMIN" },
    });
    await prisma.minecraftAccount.create({
      data: { id: "online-account", name: "Bot_Cmd_5", serverHost: "h", serverPort: 25565 },
    });
    sendCommandMock.mockReturnValue(false);

    const result = await executeCommand(toSession(admin as any), "online-account", "/say hi");
    expect(result).toEqual({ ok: false, reason: "OFFLINE" });
  });
});
