import { afterEach, describe, expect, it, vi } from "vitest";
import type { MinecraftAccount } from "@prisma/client";
import { ClientManager } from "../../src/minecraft/ClientManager.js";
import { prisma } from "../../src/database/prisma.js";
import type { ClientStatus } from "../../src/minecraft/types.js";

afterEach(() => vi.restoreAllMocks());

function account(id: string, edition: "JAVA" | "BEDROCK" = "JAVA"): MinecraftAccount {
  return {
    id, name: id, serverHost: "localhost", serverPort: 25565, minecraftVersion: "",
    edition, authType: "OFFLINE", credentialsSecret: null, credentialsPassword: null,
    crouchEnabled: true, autoReconnect: true, autoSellEnabled: false,
    autoSellIntervalSeconds: 60, autoSellCommand: "/sell", spawnerType: "", spawnerActions: "{}",
  } as MinecraftAccount;
}

describe("restart all online Minecraft accounts", () => {
  it("takes one online snapshot, restarts both editions once and leaves other states alone", () => {
    const manager = new ClientManager();
    const persistence = vi.spyOn(prisma.minecraftAccount, "update").mockResolvedValue({} as MinecraftAccount);
    const states: ClientStatus[] = ["ONLINE", "ONLINE", "OFFLINE", "CONNECTING", "RECONNECTING", "ERROR"];
    const clients = states.map((state, index) => {
      const client = manager.register(account(`account-${index}`, index === 1 ? "BEDROCK" : "JAVA"));
      vi.spyOn(client, "getStatus").mockImplementation(() => ({
        id: `account-${index}`, name: `account-${index}`, status: states[index], serverHost: "localhost", serverPort: 25565,
      }));
      const restart = vi.spyOn(client, "restart").mockImplementation(() => { states[index] = "OFFLINE"; });
      return { client, restart, state };
    });
    expect(manager.restartAllOnline()).toEqual({ restarted: ["account-0", "account-1"], failed: [] });
    for (const [index, entry] of clients.entries()) expect(entry.restart).toHaveBeenCalledTimes(index < 2 ? 1 : 0);
    expect(persistence).toHaveBeenCalledTimes(2);
    expect(manager.restartAllOnline()).toEqual({ restarted: [], failed: [] });
    expect(clients[0].restart).toHaveBeenCalledTimes(1);
    expect(clients[1].restart).toHaveBeenCalledTimes(1);
  });

  it("continues restarting other online accounts when one fails", () => {
    const manager = new ClientManager();
    vi.spyOn(prisma.minecraftAccount, "update").mockResolvedValue({} as MinecraftAccount);
    const first = manager.register(account("first"));
    const second = manager.register(account("second", "BEDROCK"));
    for (const client of [first, second]) {
      vi.spyOn(client, "getStatus").mockReturnValue({ id: "unused", name: "unused", status: "ONLINE", serverHost: "localhost", serverPort: 25565 });
    }
    vi.spyOn(first, "restart").mockImplementation(() => { throw Error("restart failed"); });
    const restart = vi.spyOn(second, "restart").mockImplementation(() => {});
    expect(manager.restartAllOnline()).toEqual({ restarted: ["second"], failed: ["first"] });
    expect(restart).toHaveBeenCalledOnce();
  });
});
