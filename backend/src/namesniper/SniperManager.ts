import { SniperClient } from "./SniperClient.js";
import type { SniperConsoleEvent, SniperRuntimeConfig, SniperStatusSnapshot } from "./types.js";
import { prisma } from "../database/prisma.js";
import { persistSniperLog } from "../logging/sniperLogService.js";
import { logger } from "../logging/logger.js";
import { decryptSecret } from "../utils/crypto.js";
import type { SniperAccount } from "@prisma/client";

export type SniperConsoleEventListener = (event: SniperConsoleEvent) => void;
export type SniperStatusEventListener = (status: SniperStatusSnapshot) => void;

function toRuntimeConfig(account: SniperAccount): SniperRuntimeConfig {
  return {
    id: account.id,
    email: account.email,
    desiredName: account.desiredName,
    cooldownSeconds: account.cooldownSeconds,
    rateLimitProtection: account.rateLimitProtection,
    proxies: parseProxies(account.proxies),
  };
}

/** Split the stored newline/comma-separated proxy blob into clean entries.
 *  The column is encrypted at rest, so decrypt first (legacy plaintext rows
 *  pass through unchanged). */
function parseProxies(raw: string): string[] {
  return decryptSecret(raw)
    .split(/[\r\n,]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Owns every SniperClient instance in the process (one per Name Sniper
 * account) and fans out console/status events to subscribers (the WebSocket
 * layer). Mirrors ClientManager but for the independent Name Sniper feature.
 */
export class SniperManager {
  private clients = new Map<string, SniperClient>();
  private consoleListeners = new Set<SniperConsoleEventListener>();
  private statusListeners = new Set<SniperStatusEventListener>();

  onConsoleEvent(listener: SniperConsoleEventListener): () => void {
    this.consoleListeners.add(listener);
    return () => this.consoleListeners.delete(listener);
  }

  onStatusEvent(listener: SniperStatusEventListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Loads all sniper accounts from the DB, then resumes the ones that were
   * enabled before the process/host restarted. */
  async loadAll(): Promise<void> {
    const accounts = await prisma.sniperAccount.findMany();
    for (const account of accounts) {
      this.register(account);
      if (account.status !== "OFFLINE") {
        await prisma.sniperAccount.update({ where: { id: account.id }, data: { status: "OFFLINE" } });
      }
    }
    const toResume = accounts.filter((a) => a.enabled);
    for (const account of toResume) {
      this.start(account.id);
    }
    logger.info(
      { count: accounts.length, resumed: toResume.length },
      "Loaded Name Sniper accounts into SniperManager",
    );
  }

  register(account: SniperAccount): SniperClient {
    let client = this.clients.get(account.id);
    if (client) {
      client.updateConfig(toRuntimeConfig(account));
      return client;
    }

    client = new SniperClient(toRuntimeConfig(account));
    client.on("console", (event: SniperConsoleEvent) => {
      persistSniperLog(event.sniperAccountId, event.type, event.message).catch((err) =>
        logger.error({ err }, "Failed to persist sniper console log"),
      );
      for (const listener of this.consoleListeners) {
        try {
          listener(event);
        } catch (err) {
          logger.error({ err }, "Sniper console listener threw");
        }
      }
    });
    client.on("status", (status: SniperStatusSnapshot) => {
      prisma.sniperAccount
        .update({
          where: { id: status.id },
          data: {
            status: status.status,
            currentName: status.currentName,
            lastAttemptAt: status.lastAttemptAt ? new Date(status.lastAttemptAt) : undefined,
            lastResult: status.lastResult,
            lastSuccess: status.lastSuccess ?? undefined,
          },
        })
        .catch((err) => {
          if (err?.code !== "P2025") logger.error({ err }, "Failed to persist sniper status");
        });
      for (const listener of this.statusListeners) {
        try {
          listener(status);
        } catch (err) {
          logger.error({ err }, "Sniper status listener threw");
        }
      }
    });
    client.on("achieved", ({ id, name }: { id: string; name?: string }) => {
      // The desired name was successfully claimed: disable the account so it
      // doesn't try again, and clear the desired name since the goal is met.
      prisma.sniperAccount
        .update({ where: { id }, data: { enabled: false, currentName: name } })
        .catch((err) => {
          if (err?.code !== "P2025") logger.error({ err }, "Failed to persist sniper achievement");
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

  get(accountId: string): SniperClient | undefined {
    return this.clients.get(accountId);
  }

  getAllStatuses(): SniperStatusSnapshot[] {
    return Array.from(this.clients.values()).map((c) => c.getStatus());
  }

  start(accountId: string): boolean {
    const client = this.clients.get(accountId);
    if (!client) return false;
    this.persistEnabled(accountId, true);
    client.start();
    return true;
  }

  stop(accountId: string): boolean {
    const client = this.clients.get(accountId);
    if (!client) return false;
    this.persistEnabled(accountId, false);
    client.stop();
    return true;
  }

  private persistEnabled(accountId: string, enabled: boolean): void {
    prisma.sniperAccount
      .update({ where: { id: accountId }, data: { enabled } })
      .catch((err) => {
        if (err?.code !== "P2025") logger.error({ err }, "Failed to persist sniper enabled flag");
      });
  }

  /** Gracefully stops every client, e.g. during process shutdown. */
  shutdownAll(): void {
    for (const client of this.clients.values()) {
      try {
        client.stop();
      } catch (err) {
        logger.error({ err }, "Error while stopping sniper client during shutdown");
      }
    }
  }
}

export const sniperManager = new SniperManager();
