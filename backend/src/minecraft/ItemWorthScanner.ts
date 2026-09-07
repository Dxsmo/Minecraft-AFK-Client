import { prisma } from "../database/prisma.js";
import { logger } from "../logging/logger.js";
import { ITEM_REGISTRY, type RegistryItem } from "./itemRegistry.js";
import { matchWorthReply, worthChanged, type WorthReply } from "./itemWorth.js";
import { clientManager, type ClientManager } from "./ClientManager.js";

/** The scan is a singleton; this is the primary key of its one row. */
const SCAN_ID = "global";

/** How long to wait for the server to answer a single `/worth` query. */
const REPLY_TIMEOUT_MS = 8_000;

/** Bounds for the admin-configurable pause between two queries. */
export const MIN_DELAY_SECONDS = 1;
export const MAX_DELAY_SECONDS = 60;
export const DEFAULT_DELAY_SECONDS = 5;

/**
 * Give up after this many consecutive unanswered queries. Something is wrong
 * with the server or the command (renamed, permission lost), and hammering it
 * for another few hours helps nobody.
 */
const MAX_CONSECUTIVE_MISSES = 25;

/** How many unmatched chat lines to keep per query for the UI diagnostics. */
const MAX_SAMPLES_PER_QUERY = 6;

/** How long to sit idle while no selected bot is online before re-checking. */
const OFFLINE_RECHECK_MS = 5_000;

export type ScanStatus = "IDLE" | "RUNNING" | "PAUSED" | "COMPLETED" | "CANCELLED";

interface RunState {
  cancelled: boolean;
  /** Resolver for the query currently in flight, if any. */
  pending: ((reply: WorthReply | null) => void) | null;
  /** Which account was asked, so another bot's chat cannot answer for it. */
  expectedAccountId: string | null;
  /** The item currently being asked about, for correlating the reply to it. */
  expectedItem: { id: string; name: string } | null;
  /** Chat lines seen during the current query window that were not accepted. */
  samples: string[];
  replyTimer: NodeJS.Timeout | null;
  delayTimer: NodeJS.Timeout | null;
  wakeDelay: (() => void) | null;
}

/** Knobs that only the tests change; production uses the defaults above. */
export interface ItemWorthScannerOptions {
  items?: readonly RegistryItem[];
  replyTimeoutMs?: number;
  /** Multiplier applied to the configured delay, so tests can run instantly. */
  delayScale?: number;
  offlineRecheckMs?: number;
}

export function parseAccountIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** What the server said during the last query nobody could make sense of. */
export interface WorthSamples {
  itemId: string;
  command: string;
  lines: string[];
}

export function parseSamples(json: string | null): WorthSamples | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<WorthSamples>;
    if (typeof parsed?.itemId !== "string" || !Array.isArray(parsed.lines)) return null;
    return {
      itemId: parsed.itemId,
      command: typeof parsed.command === "string" ? parsed.command : `/worth ${parsed.itemId}`,
      lines: parsed.lines.filter((line): line is string => typeof line === "string"),
    };
  } catch {
    return null;
  }
}

/**
 * Walks the whole Minecraft item registry asking the server `/worth <item>`
 * and records every price, so an admin can diff two scans and spot silent
 * price changes ("off metas").
 *
 * Design notes:
 * - One site-wide scan, not one per account: a price belongs to the server, so
 *   splitting the work over several bots only changes *who* asks, not the
 *   answer. Queries go round-robin over the selected bots, which means each
 *   individual bot sends far fewer commands and draws much less attention,
 *   while the scan as a whole finishes proportionally faster.
 * - The configured delay is global: with 3 bots and 2s, one item leaves every
 *   2s but any single bot only speaks every 6s.
 * - The scan lives here in Node, not in the Rust bot: it is a slow, stateful,
 *   database-backed job, and keeping it out of the bot means no bot rebuild and
 *   no interference with the bot's foreground task queue (auto-sell, spawner).
 * - Progress is persisted after *every* item, so a scan survives a disconnect,
 *   a bot restart and a backend restart.
 */
export class ItemWorthScanner {
  private run: RunState | null = null;
  private readonly items: readonly RegistryItem[];
  private readonly replyTimeoutMs: number;
  private readonly delayScale: number;
  private readonly offlineRecheckMs: number;
  /** Round-robin cursor over the selected accounts. */
  private rrIndex = 0;

  constructor(private manager: ClientManager, options: ItemWorthScannerOptions = {}) {
    this.items = options.items ?? ITEM_REGISTRY;
    this.replyTimeoutMs = options.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    this.delayScale = options.delayScale ?? 1;
    this.offlineRecheckMs = options.offlineRecheckMs ?? OFFLINE_RECHECK_MS;

    manager.onChatEvent(({ minecraftAccountId, message }) => {
      this.handleChat(minecraftAccountId, message);
    });
    manager.onStatusEvent((status) => {
      // A bot coming back online may be the only one left to continue with.
      if (status.status === "ONLINE") void this.resumeIfPending();
    });
  }

  /**
   * Called once at boot. A scan that was RUNNING when the process died is
   * parked in PAUSED; it resumes on its own as soon as a bot reports ONLINE.
   */
  async init(): Promise<void> {
    await prisma.itemWorthScan.updateMany({
      where: { status: "RUNNING" },
      data: { status: "PAUSED" },
    });
  }

  /** Stop the in-flight scan (process shutdown). Progress stays in the DB. */
  dispose(): void {
    this.abortRun();
  }

  async getState() {
    const [scan, values] = await Promise.all([
      prisma.itemWorthScan.findUnique({ where: { id: SCAN_ID } }),
      prisma.itemWorthValue.findMany({
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
    const delaySeconds = scan?.delaySeconds ?? DEFAULT_DELAY_SECONDS;
    const remaining = Math.max(0, total - cursor);
    const resumable = scan?.resumable ?? true;
    // A paused-and-given-up scan will never move again, so it has no ETA.
    const etaSeconds =
      status === "RUNNING" || (status === "PAUSED" && resumable)
        ? remaining * delaySeconds
        : null;

    return {
      status,
      cursor,
      total,
      scanNumber: scan?.scanNumber ?? 0,
      changedCount: scan?.changedCount ?? 0,
      missedCount: scan?.missedCount ?? 0,
      resumable,
      delaySeconds,
      accountIds: parseAccountIds(scan?.accountIdsJson ?? "[]"),
      lastItemId: scan?.lastItemId ?? null,
      lastError: scan?.lastError ?? null,
      lastSamples: parseSamples(scan?.lastSamplesJson ?? null),
      startedAt: scan?.startedAt?.toISOString() ?? null,
      finishedAt: scan?.finishedAt?.toISOString() ?? null,
      etaSeconds,
      registryTotal: this.items.length,
      minDelaySeconds: MIN_DELAY_SECONDS,
      maxDelaySeconds: MAX_DELAY_SECONDS,
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

  /** Begin a fresh scan from item 0. Throws if one is already in progress. */
  async start(accountIds: string[], delaySeconds: number): Promise<void> {
    const existing = await prisma.itemWorthScan.findUnique({ where: { id: SCAN_ID } });
    if (existing && (existing.status === "RUNNING" || existing.status === "PAUSED")) {
      throw new Error("A scan is already in progress");
    }
    if (accountIds.length === 0) {
      throw new Error("Select at least one account");
    }

    const scanNumber = (existing?.scanNumber ?? 0) + 1;
    // Clear the previous run's change highlights so the page only ever shows
    // differences introduced by the newest scan.
    await prisma.itemWorthValue.updateMany({ data: { changedAt: null } });

    const shared = {
      status: "RUNNING",
      cursor: 0,
      total: this.items.length,
      scanNumber,
      resumable: true,
      delaySeconds,
      accountIdsJson: JSON.stringify(accountIds),
      changedCount: 0,
      missedCount: 0,
      lastItemId: null,
      lastError: null,
      startedAt: new Date(),
      finishedAt: null,
    };
    await prisma.itemWorthScan.upsert({
      where: { id: SCAN_ID },
      create: { id: SCAN_ID, ...shared },
      update: shared,
    });

    this.rrIndex = 0;
    this.spawnRun();
  }

  /** Cancel a running or paused scan. Already-scanned prices are kept. */
  async stop(): Promise<void> {
    this.abortRun();
    await prisma.itemWorthScan.updateMany({
      where: { id: SCAN_ID, status: { in: ["RUNNING", "PAUSED"] } },
      data: { status: "CANCELLED", finishedAt: new Date() },
    });
  }

  // ---------------------------------------------------------------- internals

  private handleChat(accountId: string, message: string): void {
    const run = this.run;
    if (!run?.pending || !run.expectedItem) return;
    // Only the bot we just asked may answer for this item.
    if (run.expectedAccountId !== null && run.expectedAccountId !== accountId) return;

    // Correlating by item name is what keeps another player's chat out of the
    // price table, and stops a reply that arrived after its own query timed out
    // from being credited to the *next* item.
    const reply = matchWorthReply(message, run.expectedItem);
    if (!reply) {
      // Remember what the server *did* say. When a query ends up unanswered
      // these lines are surfaced in the UI, which turns "no answer" from an
      // unexplainable dead end into something the admin can actually read.
      const clean = message.trim();
      if (clean !== "" && run.samples.length < MAX_SAMPLES_PER_QUERY) run.samples.push(clean);
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

  private async resumeIfPending(): Promise<void> {
    if (this.run) return;
    const scan = await prisma.itemWorthScan.findUnique({ where: { id: SCAN_ID } });
    if (!scan || (scan.status !== "PAUSED" && scan.status !== "RUNNING")) return;
    // A scan that gave up stays parked until an admin starts a new one. Status
    // events fire on every health/balance update, not just on transitions, so
    // without this guard the give-up state would be undone within seconds.
    if (!scan.resumable) return;

    await prisma.itemWorthScan.update({
      where: { id: SCAN_ID },
      data: { status: "RUNNING", lastError: null },
    });
    logger.info({ cursor: scan.cursor }, "Resuming item worth scan");
    this.spawnRun();
  }

  private spawnRun(): void {
    if (this.run) return;
    const run: RunState = {
      cancelled: false,
      pending: null,
      expectedAccountId: null,
      expectedItem: null,
      samples: [],
      replyTimer: null,
      delayTimer: null,
      wakeDelay: null,
    };
    this.run = run;
    void this.runLoop(run)
      .catch((err) => {
        logger.error({ err }, "Item worth scan crashed");
        return prisma.itemWorthScan
          .updateMany({
            where: { id: SCAN_ID, status: "RUNNING" },
            data: { status: "PAUSED", lastError: String(err?.message ?? err), resumable: false },
          })
          .catch(() => undefined);
      })
      .finally(() => {
        if (this.run === run) this.run = null;
      });
  }

  private abortRun(): void {
    const run = this.run;
    if (!run) return;
    run.cancelled = true;
    if (run.replyTimer) clearTimeout(run.replyTimer);
    if (run.delayTimer) clearTimeout(run.delayTimer);
    run.pending?.(null);
    run.pending = null;
    run.wakeDelay?.();
    this.run = null;
  }

  /**
   * The next selected account that is actually online, advancing the
   * round-robin cursor. Offline bots are simply skipped and rejoin the rotation
   * automatically as soon as they are back. Returns null when none are online.
   */
  private pickAccount(accountIds: string[]): string | null {
    for (let attempt = 0; attempt < accountIds.length; attempt += 1) {
      const accountId = accountIds[this.rrIndex % accountIds.length]!;
      this.rrIndex = (this.rrIndex + 1) % accountIds.length;
      if (this.manager.get(accountId)?.getStatus().status === "ONLINE") return accountId;
    }
    return null;
  }

  private async runLoop(run: RunState): Promise<void> {
    let consecutiveMisses = 0;

    while (!run.cancelled) {
      const scan = await prisma.itemWorthScan.findUnique({ where: { id: SCAN_ID } });
      // Deleted, cancelled or restarted from elsewhere: this loop is obsolete.
      if (!scan || scan.status !== "RUNNING") return;

      if (scan.cursor >= this.items.length) {
        await prisma.itemWorthScan.update({
          where: { id: SCAN_ID },
          data: { status: "COMPLETED", finishedAt: new Date() },
        });
        logger.info({ changed: scan.changedCount }, "Item worth scan completed");
        return;
      }

      const accountIds = parseAccountIds(scan.accountIdsJson);
      const accountId = this.pickAccount(accountIds);
      if (!accountId) {
        // Nobody to ask right now. Idle briefly and look again rather than
        // burning the item — a bot may come back at any moment.
        await this.sleep(run, this.offlineRecheckMs);
        if (run.cancelled) return;
        if (this.pickAccount(accountIds) === null) {
          await this.pause("Kein ausgewählter Account online - Scan wartet");
          return;
        }
        continue;
      }

      const client = this.manager.get(accountId)!;
      const item = this.items[scan.cursor]!;
      const reply = await this.query(run, client, accountId, item);
      if (run.cancelled) return;

      // Losing the connection mid-query must not burn the item: retry it with
      // the next bot in the rotation.
      if (reply === null && client.getStatus().status !== "ONLINE") continue;

      if (reply === null) {
        consecutiveMisses += 1;
        const advanced = await this.advance(scan.scanNumber, {
          cursor: scan.cursor + 1,
          missedCount: { increment: 1 },
          lastItemId: item.id,
          // Keep what the server actually said, so an admin can see why the
          // reply was not understood instead of just "no answer".
          lastSamplesJson: JSON.stringify({
            itemId: item.id,
            command: `/worth ${item.id}`,
            lines: run.samples,
          }),
        });
        if (!advanced) return;
        if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
          await this.pause(
            `Keine Antwort auf /worth bei ${MAX_CONSECUTIVE_MISSES} Items in Folge - Scan gestoppt`,
            false,
          );
          return;
        }
      } else {
        consecutiveMisses = 0;
        const changed = await this.persistValue(item.id, item.name, reply.value, scan.scanNumber);
        const advanced = await this.advance(scan.scanNumber, {
          cursor: scan.cursor + 1,
          lastItemId: item.id,
          lastError: null,
          ...(changed ? { changedCount: { increment: 1 } } : {}),
        });
        if (!advanced) return;
      }

      await this.sleep(run, scan.delaySeconds * 1000 * this.delayScale);
    }
  }

  /**
   * Write one item's progress, but only if this loop still owns the scan.
   * `stop()` followed by `start()` resets the cursor to 0 while an old loop may
   * still be finishing its current item; matching on the scan generation makes
   * that stale write a no-op instead of silently skipping hundreds of items.
   * Returns false when the write was rejected, i.e. this loop is obsolete.
   */
  private async advance(scanNumber: number, data: Record<string, unknown>): Promise<boolean> {
    const result = await prisma.itemWorthScan.updateMany({
      where: { id: SCAN_ID, status: "RUNNING", scanNumber },
      data,
    });
    return result.count > 0;
  }

  /**
   * Park a running scan. `resumable` false means the scan gave up rather than
   * merely losing its bots, so it must NOT be picked up again by the status
   * listener - otherwise the give-up guard would be undone by the next health
   * tick and the scan would hammer the server for hours.
   */
  private async pause(reason: string, resumable = true): Promise<void> {
    logger.info({ resumable }, `Item worth scan paused: ${reason}`);
    await prisma.itemWorthScan.updateMany({
      where: { id: SCAN_ID, status: "RUNNING" },
      data: { status: "PAUSED", lastError: reason, resumable },
    });
  }

  /** Send one `/worth <item>` from one bot and await its reply. */
  private query(
    run: RunState,
    client: { sendBackgroundCommand(command: string): boolean },
    accountId: string,
    item: RegistryItem,
  ): Promise<WorthReply | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reply: WorthReply | null) => {
        if (settled) return;
        settled = true;
        run.expectedAccountId = null;
        run.expectedItem = null;
        resolve(reply);
      };

      run.expectedAccountId = accountId;
      run.expectedItem = item;
      run.samples = [];
      run.pending = finish;
      run.replyTimer = setTimeout(() => {
        run.pending = null;
        run.replyTimer = null;
        finish(null);
      }, this.replyTimeoutMs);

      if (!client.sendBackgroundCommand(`/worth ${item.id}`)) {
        run.pending = null;
        if (run.replyTimer) clearTimeout(run.replyTimer);
        run.replyTimer = null;
        finish(null);
      }
    });
  }

  /** Store one price, carrying the old one over as `previousValue`. */
  private async persistValue(
    itemId: string,
    itemName: string,
    value: number | null,
    scanNumber: number,
  ): Promise<boolean> {
    const existing = await prisma.itemWorthValue.findUnique({ where: { itemId } });

    // The very first scan has nothing to compare against, so nothing "changed".
    const changed = existing ? worthChanged(existing.value, value) : false;

    await prisma.itemWorthValue.upsert({
      where: { itemId },
      create: {
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
