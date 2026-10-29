import path from "node:path";
import { config } from "../config/config.js";
import { stopRemoteAccount } from "../soulfire/lifecycle.js";
import { MinecraftClient } from "./MinecraftClient.js";
import type { ClientRuntimeConfig, ClientStatusSnapshot, ConsoleEvent } from "./types.js";
import { prisma } from "../database/prisma.js";
import { persistConsoleLog } from "../logging/consoleLogService.js";
import { logger } from "../logging/logger.js";
import { invalidateEarningsHistory } from "../accounts/service.js";
import { createStatusPersistence } from "./statusPersistence.js";
import { parseSpawnerActions, resolveSpawnerActions } from "./spawners.js";
import type { MinecraftAccount } from "@prisma/client";

export type ConsoleEventListener = (event: ConsoleEvent) => void;
export type StatusEventListener = (status: ClientStatusSnapshot) => void;
export type SellEventListener = (update: { id: string; lastSellAt: string }) => void;
/** Raw incoming chat/server line, formatting stripped, sender prefix removed. */
export type ChatEventListener = (event: { minecraftAccountId: string; message: string }) => void;

function toRuntimeConfig(account: MinecraftAccount): ClientRuntimeConfig {
  const spawner = resolveSpawnerActions(account.spawnerType, parseSpawnerActions(account.spawnerActions));
  return {
    id: account.id,
    name: account.name,
    minecraftVersion: account.minecraftVersion,
    serverHost: account.serverHost,
    serverPort: account.serverPort,
    edition: account.edition === "BEDROCK" ? "BEDROCK" : "JAVA",
    authType: account.authType,
    credentialsSecret: account.credentialsSecret,
    credentialsPassword: account.credentialsPassword,
    crouchEnabled: account.crouchEnabled,
    autoButton: account.autoButton,
    autoReconnect: account.autoReconnect,
    autoSellEnabled: account.autoSellEnabled,
    autoSellIntervalSeconds: account.autoSellIntervalSeconds,
    autoSellCommand: account.autoSellCommand,
    spawnerType: account.spawnerType,
    spawnerDropItems: spawner.dropItems,
    spawnerSellItems: spawner.sellItems,
  };
}

/**
 * Owns every MinecraftClient instance in the process (one per Minecraft
 * account) and fans out console/status events to subscribers (the WebSocket
 * layer). Each client is isolated: an error/crash in one never affects the
 * others, since every handler here is wrapped defensively.
 */
export class ClientManager {
  private clients = new Map<string, MinecraftClient>();
  private consoleListeners = new Set<ConsoleEventListener>();
  private statusListeners = new Set<StatusEventListener>();
  private sellListeners = new Set<SellEventListener>();
  private chatListeners = new Set<ChatEventListener>();
  onChatEvent(listener: ChatEventListener): () => void {
    this.chatListeners.add(listener);
    return () => this.chatListeners.delete(listener);
  }

  onConsoleEvent(listener: ConsoleEventListener): () => void {
    this.consoleListeners.add(listener);
    return () => this.consoleListeners.delete(listener);
  }

  onStatusEvent(listener: StatusEventListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onSellEvent(listener: SellEventListener): () => void {
    this.sellListeners.add(listener);
    return () => this.sellListeners.delete(listener);
  }

  /** Loads all accounts from the DB and registers a client for each, then
   * auto-connects the ones that were running before the process/host restarted. */
  async loadAll(): Promise<void> {
    const accounts = await prisma.minecraftAccount.findMany();
    await prisma.minecraftAccount.updateMany({ where: { status: { not: "OFFLINE" } }, data: { status: "OFFLINE" } });
    for (const account of accounts) {
      this.register(account);
    }
    // Reconcile controllers after a backend crash while SoulFire stayed alive.
    for (let offset = 0; offset < accounts.length; offset += 8) {
      await Promise.all(accounts.slice(offset, offset + 8).map(account =>
        stopRemoteAccount(path.join(config.dataDir, "bot-cache", account.id))
          .catch(err => logger.warn({ err, accountId: account.id }, "SoulFire startup reconciliation failed"))));
    }
    const toResume = accounts.filter((a) => a.autoStart);
    for (const account of toResume) {
      this.start(account.id);
    }
    logger.info(
      { count: accounts.length, resumed: toResume.length },
      "Loaded Minecraft accounts into ClientManager",
    );
  }

  register(account: MinecraftAccount): MinecraftClient {
    let client = this.clients.get(account.id);
    if (client) {
      client.updateConfig(toRuntimeConfig(account));
      return client;
    }

    client = new MinecraftClient(toRuntimeConfig(account));
    client.on("console", (event: ConsoleEvent) => {
      persistConsoleLog(event.minecraftAccountId, event.type, event.message).catch((err) =>
        logger.error({ err }, "Failed to persist console log"),
      );
      for (const listener of this.consoleListeners) {
        try {
          listener(event);
        } catch (err) {
          logger.error({ err }, "Console listener threw");
        }
      }
    });
    // Newly registered clients start OFFLINE, including after startup resets.
    const persistStatus = createStatusPersistence("OFFLINE",
      status => prisma.minecraftAccount.update({ where: { id: account.id }, data: { status } }),
      (err) => {
        // P2025 = record not found: expected/harmless when the account was
        // just deleted while its client was still emitting a final status
        // event (e.g. disconnect during teardown). Anything else is logged.
        if (!err || typeof err !== "object" || !("code" in err) || err.code !== "P2025") {
          logger.error({ err }, "Failed to persist client status");
        }
      });
    client.on("status", (status: ClientStatusSnapshot) => {
      void persistStatus(status.status);
      for (const listener of this.statusListeners) {
        try {
          listener(status);
        } catch (err) {
          logger.error({ err }, "Status listener threw");
        }
      }
    });
    client.on("chat", (event: { minecraftAccountId: string; message: string }) => {
      for (const listener of this.chatListeners) {
        try {
          listener(event);
        } catch (err) {
          logger.error({ err }, "Chat listener threw");
        }
      }
    });
    client.on("earning", ({ minecraftAccountId, amount }: { minecraftAccountId: string; amount: number }) => {
      const createdAt = new Date();
      prisma.$transaction([
        prisma.sellEarning.create({ data: { minecraftAccountId, amount, createdAt } }),
        prisma.minecraftAccount.updateMany({
          where: { id: minecraftAccountId, OR: [{ lastSellAt: null }, { lastSellAt: { lte: createdAt } }] },
          data: { lastSellAt: createdAt },
        }),
      ])
        .then(() => {
          invalidateEarningsHistory(minecraftAccountId);
          for (const listener of this.sellListeners) {
            try {
              listener({ id: minecraftAccountId, lastSellAt: createdAt.toISOString() });
            } catch (err) {
              logger.error({ err }, "Sell listener threw");
            }
          }
        })
        .catch((err) => {
          if (err?.code !== "P2025") logger.error({ err }, "Failed to persist sell earning");
        });
    });
    this.clients.set(account.id, client);
    return client;
  }

  unregister(accountId: string): void {
    const client = this.clients.get(accountId);
    if (client) {
      client.dispose();
      this.clients.delete(accountId);
    }
  }

  get(accountId: string): MinecraftClient | undefined {
    return this.clients.get(accountId);
  }

  getAllStatuses(): ClientStatusSnapshot[] {
    return Array.from(this.clients.values()).map((c) => c.getStatus());
  }

  start(accountId: string): boolean {
    const client = this.clients.get(accountId);
    if (!client) return false;
    this.persistAutoStart(accountId, true);
    client.connect();
    return true;
  }

  stop(accountId: string): boolean {
    const client = this.clients.get(accountId);
    if (!client) return false;
    this.persistAutoStart(accountId, false);
    client.disconnect();
    return true;
  }

  async restart(accountId: string): Promise<boolean> {
    const client = this.clients.get(accountId);
    if (!client) return false;
    this.persistAutoStart(accountId, true);
    await client.restart();
    return true;
  }

  restartAllOnline(): { restarted: string[]; failed: string[] } {
    // Freeze the selection before restarting any client. Connecting, stopped
    // and already restarting accounts must not be started by this action.
    const online = Array.from(this.clients.entries())
      .filter(([, client]) => client.getStatus().status === "ONLINE");
    const restarted: string[] = [];
    const failed: string[] = [];
    for (const [id, client] of online) {
      try {
        client.restart();
        this.persistAutoStart(id, true);
        restarted.push(id);
      } catch (err) {
        failed.push(id);
        logger.error({ err, accountId: id }, "Failed to restart online account");
      }
    }
    return { restarted, failed };
  }

  /** Persists the "should be running" intent so a host/process restart can
   * resume exactly the clients that were active. Fire-and-forget (harmless if
   * the account was concurrently deleted). */
  private persistAutoStart(accountId: string, autoStart: boolean): void {
    prisma.minecraftAccount
      .update({ where: { id: accountId }, data: { autoStart } })
      .catch((err) => {
        if (err?.code !== "P2025") logger.error({ err }, "Failed to persist autoStart");
      });
  }

  cleanSpawner(accountId: string): boolean {
    const client = this.clients.get(accountId);
    if (!client) return false;
    return client.cleanSpawner();
  }

  /** Gracefully disconnects every client, e.g. during process shutdown. */
  async shutdownAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map(async client => {
      try { await client.shutdown(); }
      catch (err) { logger.error({ err }, "Error while disconnecting client during shutdown"); }
    }));
  }

}

export const clientManager = new ClientManager();
