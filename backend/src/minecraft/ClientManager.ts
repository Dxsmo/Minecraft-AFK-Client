import { MinecraftClient } from "./MinecraftClient.js";
import type { ClientRuntimeConfig, ClientStatusSnapshot, ConsoleEvent } from "./types.js";
import { prisma } from "../database/prisma.js";
import { persistConsoleLog } from "../logging/consoleLogService.js";
import { logger } from "../logging/logger.js";
import { parseAllowlist, parseDailyTimes, parseHomes, parseHugoSettings } from "../accounts/service.js";
import type { MinecraftAccount } from "@prisma/client";

export type ConsoleEventListener = (event: ConsoleEvent) => void;
export type StatusEventListener = (status: ClientStatusSnapshot) => void;

function toRuntimeConfig(account: MinecraftAccount): ClientRuntimeConfig {
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
    afkEnabled: account.afkEnabled,
    movementEnabled: account.movementEnabled,
    crouchEnabled: account.crouchEnabled,
    afkIntervalSeconds: account.afkIntervalSeconds,
    autoReconnect: account.autoReconnect,
    autoCommandEnabled: account.autoCommandEnabled,
    autoCommandText: account.autoCommandText,
    autoCommandIntervalMinutes: account.autoCommandIntervalMinutes,
    autoCommandSpanEnabled: account.autoCommandSpanEnabled,
    autoCommandSpanMinSeconds: account.autoCommandSpanMinSeconds,
    autoCommandSpanMaxSeconds: account.autoCommandSpanMaxSeconds,
    tpAutoEnabled: account.tpAutoEnabled,
    tpAutoAllowlist: parseAllowlist(account.tpAutoAllowlist),
    autoSellEnabled: account.autoSellEnabled,
    autoSellIntervalSeconds: account.autoSellIntervalSeconds,
    autoSellCommand: account.autoSellCommand,
    dailyCommandEnabled: account.dailyCommandEnabled,
    dailyCommandTimes: parseDailyTimes(account.dailyCommandTimes),
    balanceEnabled: account.balanceEnabled,
    balanceCommand: account.balanceCommand,
    homes: parseHomes(account.homesJson),
    hugoSettingsCommand: account.hugoSettingsCommand,
    hugoSettings: parseHugoSettings(account.hugoSettingsJson),
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

  onConsoleEvent(listener: ConsoleEventListener): () => void {
    this.consoleListeners.add(listener);
    return () => this.consoleListeners.delete(listener);
  }

  onStatusEvent(listener: StatusEventListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Loads all accounts from the DB and registers a client for each, then
   * auto-connects the ones that were running before the process/host restarted. */
  async loadAll(): Promise<void> {
    const accounts = await prisma.minecraftAccount.findMany();
    for (const account of accounts) {
      this.register(account);
      // Reset any stale ONLINE/CONNECTING status left over from a previous
      // process that crashed/was killed without a clean shutdown.
      if (account.status !== "OFFLINE") {
        await prisma.minecraftAccount.update({ where: { id: account.id }, data: { status: "OFFLINE" } });
      }
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
    client.on("status", (status: ClientStatusSnapshot) => {
      prisma.minecraftAccount
        .update({ where: { id: status.id }, data: { status: status.status } })
        .catch((err) => {
          // P2025 = record not found: expected/harmless when the account was
          // just deleted while its client was still emitting a final status
          // event (e.g. disconnect during teardown). Anything else is logged.
          if (err?.code !== "P2025") logger.error({ err }, "Failed to persist client status");
        });
      for (const listener of this.statusListeners) {
        try {
          listener(status);
        } catch (err) {
          logger.error({ err }, "Status listener threw");
        }
      }
    });
    client.on("balance", ({ minecraftAccountId, balance }: { minecraftAccountId: string; balance: number }) => {
      prisma.minecraftAccount
        .update({ where: { id: minecraftAccountId }, data: { lastBalance: balance, lastBalanceAt: new Date() } })
        .catch((err) => {
          if (err?.code !== "P2025") logger.error({ err }, "Failed to persist balance");
        });
    });
    client.on("earning", ({ minecraftAccountId, amount }: { minecraftAccountId: string; amount: number }) => {
      prisma.sellEarning
        .create({ data: { minecraftAccountId, amount } })
        .catch((err) => {
          if (err?.code !== "P2025") logger.error({ err }, "Failed to persist sell earning");
        });
    });
    client.on("homes", ({ minecraftAccountId, homes }: { minecraftAccountId: string; homes: string[] }) => {
      prisma.minecraftAccount
        .update({ where: { id: minecraftAccountId }, data: { homesJson: JSON.stringify(homes) } })
        .catch((err) => {
          if (err?.code !== "P2025") logger.error({ err }, "Failed to persist homes");
        });
    });
    client.on(
      "hugoSettings",
      ({
        minecraftAccountId,
        settings,
      }: {
        minecraftAccountId: string;
        settings: { label: string; enabled: boolean }[];
      }) => {
        prisma.minecraftAccount
          .update({
            where: { id: minecraftAccountId },
            data: { hugoSettingsJson: JSON.stringify(settings) },
          })
          .catch((err) => {
            if (err?.code !== "P2025") logger.error({ err }, "Failed to persist hugo settings");
          });
      },
    );
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

  scanHugoSettings(accountId: string): boolean {
    const client = this.clients.get(accountId);
    if (!client) return false;
    return client.scanHugoSettings();
  }

  setHugoSetting(accountId: string, label: string, enabled: boolean): boolean {
    const client = this.clients.get(accountId);
    if (!client) return false;
    return client.setHugoSetting(label, enabled);
  }

  getHugoSettings(accountId: string) {
    return this.clients.get(accountId)?.getHugoSettings();
  }

  requestInventory(accountId: string): void {
    this.clients.get(accountId)?.requestInventory();
  }

  getInventory(accountId: string) {
    return this.clients.get(accountId)?.getInventory();
  }

  moveInventoryItem(accountId: string, from: number, to: number): boolean {
    const client = this.clients.get(accountId);
    if (!client) return false;
    return client.moveInventoryItem(from, to);
  }

  dropInventoryItem(accountId: string, slot: number): boolean {
    const client = this.clients.get(accountId);
    if (!client) return false;
    return client.dropInventoryItem(slot);
  }

  /** Gracefully disconnects every client, e.g. during process shutdown. */
  shutdownAll(): void {
    for (const client of this.clients.values()) {
      try {
        client.disconnect();
      } catch (err) {
        logger.error({ err }, "Error while disconnecting client during shutdown");
      }
    }
  }
}

export const clientManager = new ClientManager();
