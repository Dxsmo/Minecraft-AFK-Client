import { prisma } from "../database/prisma.js";
import { logger } from "../logging/logger.js";
import { ITEM_REGISTRY, type RegistryItem } from "./itemRegistry.js";
import { parseWorthReply, worthChanged, nextQueryDelayMs, type WorthReply } from "./itemWorth.js";
import { clientManager, type ClientManager } from "./ClientManager.js";

/** How long to wait for the server to answer a single `/worth` query. */
const REPLY_TIMEOUT_MS = 8_000;
/** Random pause between two queries, as requested: 5 to 10 seconds. */
const MIN_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 10;
/**
 * Give up after this many consecutive unanswered queries. Something is wrong
 * with the server or the command (renamed, permission lost), and hammering it
 * for another three hours helps nobody.
 */
const MAX_CONSECUTIVE_MISSES = 25;

export type ScanStatus = "IDLE" | "RUNNING" | "PAUSED" | "COMPLETED" | "CANCELLED";

interface RunState {
  cancelled: boolean;
  /** Resolver for the query currently in flight, if any. */
  pending: ((reply: WorthReply | null) => void) | null;
  /** Display name of the item currently being asked about, for correlation. */
  expectedName: string | null;
  replyTimer: NodeJS.Timeout | null;
  delayTimer: NodeJS.Timeout | null;
  wakeDelay: (() => void) | null;
}

/**
 * Walks the whole Minecraft item registry asking the server `/worth <item>`
 * and records every price, so an admin can diff two scans and spot silent
 * price changes ("off metas").
 *
 * Design notes:
 * - The scan lives here in Node, not in the Rust bot: it is a slow, stateful,
 *   database-backed job, and keeping it out of the bot means no bot rebuild and
 *   no interference with the bot's foreground task queue (auto-sell, spawner).
 * - Progress is persisted after *every* item. A scan takes ~3 hours, so it has
 *   to survive a disconnect, a bot restart and a backend restart.
 * - A scan only ever runs because an admin pressed the button. On disconnect it
 *   parks itself in PAUSED and resumes automatically once the bot is back.
 */
/** Knobs that only the tests change; production uses the defaults above. */
export interface ItemWorthScannerOptions {
  items?: readonly RegistryItem[];
  minDelaySeconds?: number;
  maxDelaySeconds?: number;
  replyTimeoutMs?: number;
}

export class ItemWorthScanner {
  private runs = new Map<string, RunState>();
  private readonly items: readonly RegistryItem[];
  private readonly minDelaySeconds: number;
  private readonly maxDelaySeconds: number;
  private readonly replyTimeoutMs: number;

  constructor(private manager: ClientManager, options: ItemWorthScannerOptions = {}) {
    this.items = options.items ?? ITEM_REGISTRY;
    this.minDelaySeconds = options.minDelaySeconds ?? MIN_DELAY_SECONDS;
    this.maxDelaySeconds = options.maxDelaySeconds ?? MAX_DELAY_SECONDS;
    this.replyTimeoutMs = options.replyTimeoutMs ?? REPLY_TIMEOUT_MS;

    manager.onChatEvent(({ minecraftAccountId, message }) => {
      this.handleChat(minecraftAccountId, message);
    });
    manager.onStatusEvent((status) => {
      if (status.status === "ONLINE") void this.resumeIfPending(status.id);
    });
  }

  /**
   * Called once at boot. A scan that was RUNNING when the process died is
   * parked in PAUSED; it resumes on its own as soon as the bot reports ONLINE.
   */
  async init(): Promise<void> {
    await prisma.itemWorthScan.updateMany({
      where: { status: "RUNNING" },
      data: { status: "PAUSED" },
    });
  }

  /** Stop every in-flight scan (process shutdown). Progress stays in the DB. */
  dispose(): void {
    for (const accountId of [...this.runs.keys()]) this.abortRun(accountId);
  }

  async getState(accountId: string) {
    const [scan, values] = await Promise.all([
      prisma.itemWorthScan.findUnique({ where: { minecraftAccountId: accountId } }),
      prisma.itemWorthValue.findMany({
        where: { minecraftAccountId: accountId },
        orderBy: { itemName: "asc" },
        select: {
          itemId: true,
          itemName: true,
          value: true,
          previousValue: true,
          hasPrevious: true,
          changedAt: true,
          updatedAt: true,
        },
      }),
    ]);

    const status = (scan?.status ?? "IDLE") as ScanStatus;
    const cursor = scan?.cursor ?? 0;
    const total = scan?.total || this.items.length;
    const remaining = Math.max(0, total - cursor);
    // Average pace, used for the "done in ~x" hint in the UI.
    const etaSeconds =
      status === "RUNNING" || (status === "PAUSED" && (scan?.resumable ?? true))
        ? Math.round((remaining * (this.minDelaySeconds + this.maxDelaySeconds)) / 2)
        : null;

    return {
      status,
      cursor,
      total,
      scanNumber: scan?.scanNumber ?? 0,
      changedCount: scan?.changedCount ?? 0,
      missedCount: scan?.missedCount ?? 0,
      lastItemId: scan?.lastItemId ?? null,
      lastError: scan?.lastError ?? null,
      resumable: scan?.resumable ?? true,
      startedAt: scan?.startedAt?.toISOString() ?? null,
      finishedAt: scan?.finishedAt?.toISOString() ?? null,
      etaSeconds,
      registryTotal: this.items.length,
      values: values.map((v) => ({
        itemId: v.itemId,
        itemName: v.itemName,
        value: v.value,
        previousValue: v.previousValue,
        hasPrevious: v.hasPrevious,
        changed: v.changedAt !== null,
        updatedAt: v.updatedAt.toISOString(),
      })),
    };
  }

  /** Begin a fresh scan from item 0. Throws if one is already running. */
  async start(accountId: string): Promise<void> {
    const existing = await prisma.itemWorthScan.findUnique({
      where: { minecraftAccountId: accountId },
    });
    if (existing && (existing.status === "RUNNING" || existing.status === "PAUSED")) {
      throw new Error("A scan is already in progress");
    }

    const scanNumber = (existing?.scanNumber ?? 0) + 1;
    // Clear the previous run's change highlights so the tab only ever shows
    // differences introduced by the newest scan.
    await prisma.itemWorthValue.updateMany({
      where: { minecraftAccountId: accountId },
      data: { changedAt: null },
    });
    await prisma.itemWorthScan.upsert({
      where: { minecraftAccountId: accountId },
      create: {
        minecraftAccountId: accountId,
        status: "RUNNING",
        cursor: 0,
        total: this.items.length,
        scanNumber,
        resumable: true,
        startedAt: new Date(),
      },
      update: {
        status: "RUNNING",
        cursor: 0,
        total: this.items.length,
        scanNumber,
        resumable: true,
        changedCount: 0,
        missedCount: 0,
        lastItemId: null,
        lastError: null,
        startedAt: new Date(),
        finishedAt: null,
      },
    });

    this.spawnRun(accountId);
  }

  /** Cancel a running or paused scan. Already-scanned prices are kept. */
  async stop(accountId: string): Promise<void> {
    this.abortRun(accountId);
    await prisma.itemWorthScan.updateMany({
      where: { minecraftAccountId: accountId, status: { in: ["RUNNING", "PAUSED"] } },
      data: { status: "CANCELLED", finishedAt: new Date() },
    });
  }

  // ---------------------------------------------------------------- internals

  private handleChat(accountId: string, message: string): void {
    const run = this.runs.get(accountId);
    if (!run?.pending) return;
    const reply = parseWorthReply(message);
    if (!reply) return;
    // Only accept a reply that names the item we actually asked about. Without
    // this, any player typing "Der Wert von X beträgt $999" into public chat
    // would be written into the price table, and a reply arriving after its own
    // query timed out would be credited to the *next* item.
    if (
      reply.itemName !== null &&
      run.expectedName !== null &&
      reply.itemName.toLowerCase() !== run.expectedName.toLowerCase()
    ) {
      return;
    }
    const resolve = run.pending;
    run.pending = null;
    if (run.replyTimer) {
      clearTimeout(run.replyTimer);
      run.replyTimer = null;
    }
    resolve(reply);
  }

  private async resumeIfPending(accountId: string): Promise<void> {
    if (this.runs.has(accountId)) return;
    const scan = await prisma.itemWorthScan.findUnique({
      where: { minecraftAccountId: accountId },
    });
    if (!scan || (scan.status !== "PAUSED" && scan.status !== "RUNNING")) return;
    // A scan that gave up stays parked until an admin starts a new one. Status
    // events fire on every health/balance update, not just on transitions, so
    // without this guard the give-up state would be undone within seconds.
    if (!scan.resumable) return;
    await prisma.itemWorthScan.update({
      where: { minecraftAccountId: accountId },
      data: { status: "RUNNING", lastError: null },
    });
    logger.info({ accountId, cursor: scan.cursor }, "Resuming item worth scan");
    this.spawnRun(accountId);
  }

  private spawnRun(accountId: string): void {
    if (this.runs.has(accountId)) return;
    const run: RunState = {
      cancelled: false,
      pending: null,
      expectedName: null,
      replyTimer: null,
      delayTimer: null,
      wakeDelay: null,
    };
    this.runs.set(accountId, run);
    void this.runLoop(accountId, run).catch((err) => {
      logger.error({ err, accountId }, "Item worth scan crashed");
      return prisma.itemWorthScan
        .updateMany({
          where: { minecraftAccountId: accountId, status: "RUNNING" },
          data: { status: "PAUSED", lastError: String(err?.message ?? err), resumable: false },
        })
        .catch(() => undefined);
    }).finally(() => {
      if (this.runs.get(accountId) === run) this.runs.delete(accountId);
    });
  }

  private abortRun(accountId: string): void {
    const run = this.runs.get(accountId);
    if (!run) return;
    run.cancelled = true;
    if (run.replyTimer) clearTimeout(run.replyTimer);
    if (run.delayTimer) clearTimeout(run.delayTimer);
    run.pending?.(null);
    run.pending = null;
    run.wakeDelay?.();
    this.runs.delete(accountId);
  }

  private async runLoop(accountId: string, run: RunState): Promise<void> {
    let consecutiveMisses = 0;

    while (!run.cancelled) {
      const scan = await prisma.itemWorthScan.findUnique({
        where: { minecraftAccountId: accountId },
      });
      // Deleted, cancelled or restarted from elsewhere: this loop is obsolete.
      if (!scan || scan.status !== "RUNNING") return;

      if (scan.cursor >= this.items.length) {
        await prisma.itemWorthScan.update({
          where: { minecraftAccountId: accountId },
          data: { status: "COMPLETED", finishedAt: new Date() },
        });
        logger.info({ accountId, changed: scan.changedCount }, "Item worth scan completed");
        return;
      }

      const client = this.manager.get(accountId);
      if (!client || client.getStatus().status !== "ONLINE") {
        // Park the scan; the status listener restarts it once the bot is back.
        await this.pause(accountId, "Bot offline - scan paused, resumes automatically");
        return;
      }

      const item = this.items[scan.cursor]!;
      const reply = await this.query(run, client, item.id, item.name);
      if (run.cancelled) return;

      // Losing the connection mid-query must not burn the item: park the scan
      // and let it retry this exact item once the bot is back.
      if (reply === null && client.getStatus().status !== "ONLINE") {
        await this.pause(accountId, "Bot offline - scan paused, resumes automatically");
        return;
      }

      if (reply === null) {
        consecutiveMisses += 1;
        const advanced = await this.advance(accountId, scan.scanNumber, {
          cursor: scan.cursor + 1,
          missedCount: { increment: 1 },
          lastItemId: item.id,
        });
        if (!advanced) return;
        if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
          await this.pause(
            accountId,
            `No answer to /worth for ${MAX_CONSECUTIVE_MISSES} items in a row - scan stopped`,
            false,
          );
          return;
        }
      } else {
        consecutiveMisses = 0;
        const changed = await this.persistValue(accountId, item.id, item.name, reply.value, scan.scanNumber);
        const advanced = await this.advance(accountId, scan.scanNumber, {
          cursor: scan.cursor + 1,
          lastItemId: item.id,
          lastError: null,
          ...(changed ? { changedCount: { increment: 1 } } : {}),
        });
        if (!advanced) return;
      }

      await this.sleep(run, nextQueryDelayMs(this.minDelaySeconds, this.maxDelaySeconds));
    }
  }

  /**
   * Park a running scan. `resumable` false means the scan gave up rather than
   * merely losing the bot, so it must NOT be picked up again by the status
   * listener - otherwise the give-up guard would be undone by the next health
   * tick and the scan would hammer the server for its full three hours.
   */
  /**
   * Write one item's progress, but only if this loop still owns the scan.
   * `stop()` followed by `start()` resets the cursor to 0 while an old loop may
   * still be finishing its current item; matching on the scan generation makes
   * that stale write a no-op instead of silently skipping hundreds of items.
   * Returns false when the write was rejected, i.e. this loop is obsolete.
   */
  private async advance(
    accountId: string,
    scanNumber: number,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await prisma.itemWorthScan.updateMany({
      where: { minecraftAccountId: accountId, status: "RUNNING", scanNumber },
      data,
    });
    return result.count > 0;
  }

  private async pause(accountId: string, reason: string, resumable = true): Promise<void> {
    logger.info({ accountId, resumable }, `Item worth scan paused: ${reason}`);
    await prisma.itemWorthScan.updateMany({
      where: { minecraftAccountId: accountId, status: "RUNNING" },
      data: { status: "PAUSED", lastError: reason, resumable },
    });
  }

  /** Send one `/worth <item>` and wait for the reply, or null on timeout. */
  private query(
    run: RunState,
    client: { sendBackgroundCommand(command: string): boolean },
    itemId: string,
    expectedName: string,
  ): Promise<WorthReply | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reply: WorthReply | null) => {
        if (settled) return;
        settled = true;
        run.expectedName = null;
        resolve(reply);
      };

      run.expectedName = expectedName;
      run.pending = finish;
      run.replyTimer = setTimeout(() => {
        run.pending = null;
        run.replyTimer = null;
        finish(null);
      }, this.replyTimeoutMs);

      if (!client.sendBackgroundCommand(`/worth ${itemId}`)) {
        run.pending = null;
        if (run.replyTimer) clearTimeout(run.replyTimer);
        run.replyTimer = null;
        finish(null);
      }
    });
  }

  /** Store one price, carrying the old one over as `previousValue`. */
  private async persistValue(
    accountId: string,
    itemId: string,
    itemName: string,
    value: number | null,
    scanNumber: number,
  ): Promise<boolean> {
    const existing = await prisma.itemWorthValue.findUnique({
      where: { minecraftAccountId_itemId: { minecraftAccountId: accountId, itemId } },
    });

    // The very first scan has nothing to compare against, so nothing "changed".
    const changed = existing ? worthChanged(existing.value, value) : false;

    await prisma.itemWorthValue.upsert({
      where: { minecraftAccountId_itemId: { minecraftAccountId: accountId, itemId } },
      create: {
        minecraftAccountId: accountId,
        itemId,
        itemName,
        value,
        hasPrevious: false,
        previousValue: null,
        scanNumber,
        changedAt: null,
      },
      update: {
        itemName,
        value,
        hasPrevious: true,
        previousValue: existing?.value ?? null,
        scanNumber,
        changedAt: changed ? new Date() : null,
      },
    });

    return changed;
  }

  /** Interruptible sleep so stopping a scan does not wait out the full pause. */
  private sleep(run: RunState, ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (run.cancelled) {
        resolve();
        return;
      }
      run.wakeDelay = () => {
        if (run.delayTimer) clearTimeout(run.delayTimer);
        run.delayTimer = null;
        run.wakeDelay = null;
        resolve();
      };
      run.delayTimer = setTimeout(() => {
        run.delayTimer = null;
        run.wakeDelay = null;
        resolve();
      }, ms);
    });
  }
}

export const itemWorthScanner = new ItemWorthScanner(clientManager);
