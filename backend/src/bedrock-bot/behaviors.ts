//! Behavior engine for the Bedrock bot: the periodic tick loop plus the
//! task-interrupt system, mirroring the Azalea bot's behavior model so the
//! Node backend gets the same events regardless of edition.
//!
//! Continuous work (auto-sell, anti-idle swing, auto-command) yields to
//! one-shot foreground tasks (daily command / balance query / inventory move):
//! while a foreground task is running, auto-sell does not start, and it resumes
//! on the next tick once the foreground task has completed. Foreground tasks run
//! one at a time, so no two Minecraft actions race each other.

import { emit, type BehaviorConfig, type Config, type InventorySlot, type OutEvent } from "./protocol.js";
import { BotSender } from "./send.js";

/** Milliseconds a balance query waits for the server to reply before giving up. */
const BALANCE_REPLY_TIMEOUT_MS = 8000;
/** Window after a sell command during which chat income is attributed to selling. */
const SELL_EARNING_WINDOW_MS = 4000;
/** Ignore a duplicate /tpaccept for the same player within this window. */
const TPACCEPT_DEDUP_MS = 5000;
/** Emit a heartbeat at most this often. */
const HEARTBEAT_INTERVAL_MS = 15000;
/** Rotate the view this often when movement is enabled. */
const MOVEMENT_INTERVAL_MS = 5000;

type ForegroundTask =
  | { kind: "command"; text: string }
  | { kind: "balance"; command: string }
  | { kind: "move"; from: number; to: number }
  | { kind: "drop"; slot: number }
  | { kind: "clean_spawner" };

type InvState = {
  main: (InventorySlot | null)[];
  hotbar: (InventorySlot | null)[];
  offhand: InventorySlot | null;
  armor: (InventorySlot | null)[];
  containerOpen: boolean;
};

/** Pull the first plausible currency amount out of a chat line, or null. */
export function parseCurrency(text: string): number | null {
  const m = text.match(/\$?\s?(\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number.parseFloat(m[1].replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export class BehaviorState {
  private sender: BotSender;
  private cfg: BehaviorConfig;

  private spawned = false;
  private lastHeartbeatAt = 0;
  private lastAfkAt = 0;
  private lastMoveAt = 0;
  private lastAutoCommandAt = Date.now();
  private lastAutosellAt = Date.now();

  private queue: ForegroundTask[] = [];
  /** Set while a balance query is awaiting a reply (pauses auto-sell). */
  private balanceDeadline: number | null = null;

  private sellWindowUntil = 0;
  private lastTpAccept: { name: string; at: number } | null = null;

  private sneaking = false;
  private lastHealth: { health: number; food: number } | null = null;

  private inv: InvState = { main: [], hotbar: [], offhand: null, armor: [], containerOpen: false };

  constructor(config: Config, sender: BotSender) {
    this.sender = sender;
    this.cfg = {
      afk_enabled: config.afk_enabled,
      movement_enabled: config.movement_enabled,
      crouch_enabled: config.crouch_enabled ?? false,
      afk_interval_seconds: config.afk_interval_seconds,
      auto_command_enabled: config.auto_command_enabled,
      auto_command_text: config.auto_command_text,
      auto_command_interval_minutes: config.auto_command_interval_minutes,
      tpauto_enabled: config.tpauto_enabled ?? false,
      tpauto_allowlist: config.tpauto_allowlist ?? [],
      autosell_enabled: config.autosell_enabled ?? false,
      autosell_interval_seconds: config.autosell_interval_seconds ?? 60,
      autosell_command: config.autosell_command ?? "/sell",
    };
  }

  updateConfig(cfg: BehaviorConfig): void {
    const wasCrouch = this.cfg.crouch_enabled;
    this.cfg = { ...cfg, tpauto_allowlist: cfg.tpauto_allowlist ?? [] };
    // Apply crouch changes immediately rather than waiting for the next tick.
    if (this.cfg.crouch_enabled && !wasCrouch) this.applyCrouch(true);
    if (!this.cfg.crouch_enabled && wasCrouch) this.applyCrouch(false);
  }

  markSpawned(): void {
    this.spawned = true;
    if (this.cfg.crouch_enabled) this.applyCrouch(true);
  }

  // --- Foreground task enqueue (called from stdin command handling) ---

  enqueueTask(text: string): void {
    this.queue.push({ kind: "command", text });
  }
  enqueueBalance(command: string): void {
    const pending = this.balanceDeadline != null || this.queue.some((t) => t.kind === "balance");
    if (!pending) this.queue.push({ kind: "balance", command });
  }
  enqueueMoveItem(from: number, to: number): void {
    this.queue.push({ kind: "move", from, to });
  }
  enqueueDropItem(slot: number): void {
    this.queue.push({ kind: "drop", slot });
  }
  enqueueCleanSpawner(): void {
    this.queue.push({ kind: "clean_spawner" });
  }

  private foregroundBusy(): boolean {
    return this.balanceDeadline != null;
  }

  // --- Periodic tick, driven by index.ts ---

  onTick(): void {
    const now = Date.now();

    if (now - this.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      this.lastHeartbeatAt = now;
      emit({ type: "heartbeat" });
    }

    if (!this.spawned) return;

    // Balance reply timeout: stop pausing auto-sell if the server never answered.
    if (this.balanceDeadline != null && now >= this.balanceDeadline) {
      this.balanceDeadline = null;
      emit({ type: "warning", message: "Balance: no reply from the server (timed out)" });
    }

    // Run at most one foreground task per tick while none is blocking.
    if (!this.foregroundBusy()) {
      const task = this.queue.shift();
      if (task) this.runForeground(task, now);
    }

    // Keep crouching applied (cheap; the sender de-dupes via its own state).
    if (this.cfg.crouch_enabled && !this.sneaking) this.applyCrouch(true);

    // Continuous auto-sell yields to any foreground task.
    if (this.cfg.autosell_enabled && !this.foregroundBusy()) {
      const interval = Math.max(1, this.cfg.autosell_interval_seconds ?? 60) * 1000;
      if (now - this.lastAutosellAt >= interval) {
        this.lastAutosellAt = now;
        const command = (this.cfg.autosell_command ?? "/sell").trim() || "/sell";
        this.sellWindowUntil = now + SELL_EARNING_WINDOW_MS;
        this.sender.command(command);
        emit({ type: "behavior_log", message: `Auto-sell: ran ${command}` });
      }
    }

    // Auto-command at its own interval, independent of AFK/movement.
    if (this.cfg.auto_command_enabled && this.cfg.auto_command_text.trim()) {
      const interval = Math.max(1, this.cfg.auto_command_interval_minutes) * 60_000;
      if (now - this.lastAutoCommandAt >= interval) {
        this.lastAutoCommandAt = now;
        this.sender.send(this.cfg.auto_command_text.trim());
        emit({ type: "behavior_log", message: "Auto-command sent" });
      }
    }

    // Anti-idle swing.
    if (this.cfg.afk_enabled) {
      const interval = Math.max(5, this.cfg.afk_interval_seconds) * 1000;
      if (now - this.lastAfkAt >= interval) {
        this.lastAfkAt = now;
        this.sender.swing();
      }
    }

    // Movement: periodically rotate the view.
    if (this.cfg.movement_enabled && now - this.lastMoveAt >= MOVEMENT_INTERVAL_MS) {
      this.lastMoveAt = now;
      this.sender.rotate(Math.floor(Math.random() * 360) - 180);
    }
  }

  private runForeground(task: ForegroundTask, now: number): void {
    switch (task.kind) {
      case "command":
        this.sender.send(task.text);
        emit({ type: "behavior_log", message: `Scheduled command dispatched: ${task.text}` });
        break;
      case "balance":
        this.balanceDeadline = now + BALANCE_REPLY_TIMEOUT_MS;
        this.sender.command(task.command);
        break;
      case "move":
        this.doMoveItem(task.from, task.to);
        break;
      case "drop":
        this.doDropItem(task.slot);
        break;
      case "clean_spawner":
        // Clean-spawner needs precise world/block interaction and container item
        // handling that is server- and world-specific and cannot be implemented
        // reliably (or verified) on Bedrock with the low-level protocol. Rather
        // than fake it, surface a clear message. See docs/LIMITATIONS.md.
        emit({
          type: "warning",
          message: "Clean-spawner is not available on Bedrock accounts (see LIMITATIONS.md).",
        });
        break;
    }
  }

  // --- Inbound chat, parsed for tpa / balance / sell ---

  onChat(sender: string | null, message: string): void {
    const now = Date.now();

    // Balance reply.
    if (this.balanceDeadline != null) {
      const amount = parseCurrency(message);
      if (amount != null && /bal|balance|money|coins|\$/i.test(message)) {
        this.balanceDeadline = null;
        emit({ type: "balance", balance: amount, raw: message } satisfies OutEvent);
      }
    }

    // Sell earning within the post-sell window.
    if (now <= this.sellWindowUntil && /sold|sell|received|earned|\+\s?\$/i.test(message)) {
      const amount = parseCurrency(message);
      if (amount != null && amount > 0) {
        emit({ type: "sell_earning", amount, raw: message } satisfies OutEvent);
      }
    }

    // Auto-accept /tpa requests.
    if (this.cfg.tpauto_enabled && /request(?:ed)?\b.*teleport|teleport.*to you|wants to teleport|/i.test(message)) {
      // Ignore /tpahere ("teleport to them") requests.
      if (/tpahere|teleport to (?:them|their)/i.test(message)) return;
      const requester = this.extractTpaRequester(message) ?? sender ?? "";
      const allow = this.cfg.tpauto_allowlist ?? [];
      if (allow.length > 0 && !allow.some((n) => n.toLowerCase() === requester.toLowerCase())) return;
      if (this.lastTpAccept && this.lastTpAccept.name === requester && now - this.lastTpAccept.at < TPACCEPT_DEDUP_MS) {
        return;
      }
      this.lastTpAccept = { name: requester, at: now };
      this.sender.command("/tpaccept");
      emit({ type: "behavior_log", message: `Auto-accepted /tpa${requester ? ` from ${requester}` : ""}` });
    }
  }

  private extractTpaRequester(message: string): string | null {
    const m = message.match(/([A-Za-z0-9_]{2,16})\s+(?:has|wants|would|is)/);
    return m ? m[1] : null;
  }

  // --- Health / food ---

  reportHealth(health: number | null, food: number | null): void {
    const h = health ?? this.lastHealth?.health ?? 20;
    const f = food ?? this.lastHealth?.food ?? 20;
    if (this.lastHealth && this.lastHealth.health === h && this.lastHealth.food === f) return;
    this.lastHealth = { health: h, food: f };
    emit({ type: "health", health: h, food: f } satisfies OutEvent);
  }

  // --- Inventory ---

  setContainerOpen(open: boolean): void {
    this.inv.containerOpen = open;
  }

  /** Replace the player inventory storage/hotbar from an inventory_content packet. */
  setPlayerInventory(main: (InventorySlot | null)[], hotbar: (InventorySlot | null)[]): void {
    this.inv.main = main;
    this.inv.hotbar = hotbar;
  }
  setArmor(armor: (InventorySlot | null)[]): void {
    this.inv.armor = armor;
  }
  setOffhand(offhand: InventorySlot | null): void {
    this.inv.offhand = offhand;
  }

  emitInventory(): void {
    emit({
      type: "inventory",
      main: this.inv.main,
      hotbar: this.inv.hotbar,
      offhand: this.inv.offhand,
      armor: this.inv.armor,
      // Item moves are only accepted when no container GUI is open.
      mutable: !this.inv.containerOpen,
    });
  }

  private applyCrouch(on: boolean): void {
    this.sneaking = on;
    this.sender.setSneak(on);
  }

  // ItemStackRequest-based moves are best-effort and unverified on Bedrock.
  private doMoveItem(from: number, to: number): void {
    this.sender.itemStackRequest([
      { type: "take", count: 64, source: this.slotRef(from), destination: this.slotRef(to) },
      { type: "place", count: 64, source: this.slotRef(from), destination: this.slotRef(to) },
    ]);
  }
  private doDropItem(slot: number): void {
    this.sender.itemStackRequest([{ type: "drop", count: 64, source: this.slotRef(slot), randomly: false }]);
  }
  private slotRef(slot: number): object {
    // Player inventory container. Slot indexing mirrors the Java raw player-menu
    // layout the frontend uses; on Bedrock this mapping is approximate.
    return { container: "inventory", slot };
  }
}
