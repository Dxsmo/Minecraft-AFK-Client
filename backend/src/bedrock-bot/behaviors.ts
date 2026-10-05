//! Behavior engine for the Bedrock bot: the periodic tick loop plus the
//! task-interrupt system, mirroring the Azalea bot's behavior model so the
//! Node backend gets the same events regardless of edition.
//!
//! Continuous auto-sell yields to
//! one-shot foreground tasks (manual command / inventory move):
//! while a foreground task is running, auto-sell does not start, and it resumes
//! on the next tick once the foreground task has completed. Foreground tasks run
//! one at a time, so no two Minecraft actions race each other.

import { emit, type BehaviorConfig, type Config, type InventorySlot, type OutEvent } from "./protocol.js";
import { BotSender } from "./send.js";

/** Emit a heartbeat at most this often. */
const HEARTBEAT_INTERVAL_MS = 15000;
const SPAWN_STABILIZE_MS = 250;
const TELEPORT_STABILIZE_MS = 100;
const TELEPORT_COMMAND_GUARD_MS = 750;
const CHAT_COMMAND_GUARD_MS = 100;
const INVENTORY_BUSY_DELAY_MS = 250;
const EMPTY_INVENTORY_PROBE_MS = 30_000;

type ForegroundTask =
  | { kind: "command"; text: string }
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

function isTeleportCommand(text: string): boolean {
  const command = text.trim().match(/^\/([^\s]+)/)?.[1]?.toLowerCase();
  return !!command && [
    "home", "spawn", "warp", "server", "hub", "lobby", "back", "rtp", "wild",
    "tp", "tpa", "tpahere", "tphere", "tpaccept", "tpyes", "is", "island", "skyblock",
  ].includes(command);
}

function isInventoryBusyMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (lower.includes("inventar") || lower.includes("inventory")) && (
    (lower.includes("gespeichert") && lower.includes("geladen")) ||
    lower.includes("saved or loaded") ||
    lower.includes("saving or loading") ||
    lower.includes("being saved") ||
    lower.includes("being loaded")
  );
}

export class BehaviorState {
  private sender: BotSender;
  private cfg: BehaviorConfig;

  private spawned = false;
  private lastHeartbeatAt = 0;
  private nextAutosellAt = Date.now();
  private nextEmptyProbeAt = Date.now() + EMPTY_INVENTORY_PROBE_MS;
  private inventoryKnown = false;
  private automationReadyAt = Number.POSITIVE_INFINITY;

  private manualQueue: ForegroundTask[] = [];
  private queue: ForegroundTask[] = [];

  private sneaking = false;
  private crouchResyncPending = false;
  private lastHealth: { health: number; food: number } | null = null;

  private inv: InvState = { main: [], hotbar: [], offhand: null, armor: [], containerOpen: false };

  constructor(config: Config, sender: BotSender) {
    this.sender = sender;
    this.cfg = {
      crouch_enabled: config.crouch_enabled ?? false,
      autosell_enabled: config.autosell_enabled ?? false,
      autosell_interval_seconds: config.autosell_interval_seconds ?? 60,
      autosell_command: config.autosell_command ?? "/sell",
    };
  }

  updateConfig(cfg: BehaviorConfig): void {
    const wasCrouch = this.cfg.crouch_enabled;
    const autosellChanged =
      this.cfg.autosell_enabled !== cfg.autosell_enabled ||
      this.cfg.autosell_interval_seconds !== cfg.autosell_interval_seconds ||
      this.cfg.autosell_command !== cfg.autosell_command;
    this.cfg = { ...cfg };
    if (autosellChanged && this.cfg.autosell_enabled) {
      this.nextAutosellAt = Math.max(Date.now(), this.automationReadyAt);
    }
    // Apply crouch changes immediately rather than waiting for the next tick.
    if (this.cfg.crouch_enabled && !wasCrouch) this.applyCrouch(true);
    if (!this.cfg.crouch_enabled && wasCrouch) this.applyCrouch(false);
  }

  markSpawned(): void {
    const now = Date.now();
    this.spawned = true;
    this.automationReadyAt = now + SPAWN_STABILIZE_MS;
    this.nextAutosellAt = this.automationReadyAt;
    this.crouchResyncPending = true;
  }

  markJoining(): void {
    this.spawned = false;
    this.crouchResyncPending = true;
    this.automationReadyAt = Number.POSITIVE_INFINITY;
    this.inv.containerOpen = false;
  }

  markTeleported(): void {
    this.spawned = true;
    this.inv.containerOpen = false;
    this.automationReadyAt = Date.now() + TELEPORT_STABILIZE_MS;
    this.nextAutosellAt = this.automationReadyAt;
    this.crouchResyncPending = true;
  }

  // --- Foreground task enqueue (called from stdin command handling) ---

  enqueueChat(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.manualQueue.push({ kind: "command", text: trimmed });
  }
  enqueueBackgroundChat(text: string): void {
    const trimmed = text.trim();
    if (trimmed) this.queue.push({ kind: "command", text: trimmed });
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

  // --- Periodic tick, driven by index.ts ---

  onTick(): void {
    const now = Date.now();
    let actionSentThisTick = false;

    if (now - this.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      this.lastHeartbeatAt = now;
      emit({ type: "heartbeat" });
    }

    // World switches/teleports may clear server input while our local value
    // remains true. Re-send start_sneak after the destination has settled.
    if (this.spawned && now >= this.automationReadyAt && this.cfg.crouch_enabled && (!this.sneaking || this.crouchResyncPending)) {
      this.applyCrouch(true);
      this.crouchResyncPending = false;
    }

    if (this.spawned && this.manualQueue.length) {
      this.runForeground(this.manualQueue.shift()!, now);
      return;
    }
    if (!this.spawned || now < this.automationReadyAt) return;

    // Run at most one foreground task per tick.
    const task = this.queue.shift();
    if (task) {
      this.runForeground(task, now);
      actionSentThisTick = true;
    }

    // Continuous auto-sell yields to any foreground task.
    if (this.cfg.autosell_enabled && !actionSentThisTick) {
      const interval = Math.max(0.25, this.cfg.autosell_interval_seconds ?? 60) * 1000;
      if (now >= this.nextAutosellAt) {
        const empty = this.inventoryKnown && ![...this.inv.main, ...this.inv.hotbar].some((slot) => slot && slot.count > 0);
        if (empty && now < this.nextEmptyProbeAt) return;
        this.nextEmptyProbeAt = now + EMPTY_INVENTORY_PROBE_MS;
        this.nextAutosellAt = now + interval;
        const command = (this.cfg.autosell_command ?? "/sell").trim() || "/sell";
        this.sender.command(command);
      }
    }
  }

  private runForeground(task: ForegroundTask, now: number): void {
    switch (task.kind) {
      case "command":
        this.sender.send(task.text);
        this.postponeAutomation(
          now + (isTeleportCommand(task.text) ? TELEPORT_COMMAND_GUARD_MS : CHAT_COMMAND_GUARD_MS),
        );
        emit({ type: "behavior_log", message: `Command dispatched: ${task.text}` });
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

  // --- Inbound inventory lifecycle messages ---

  onChat(sender: string | null, message: string): void {
    const now = Date.now();

    if (isInventoryBusyMessage(message)) {
      this.postponeAutomation(now + INVENTORY_BUSY_DELAY_MS);
      return;
    }

  }

  private postponeAutomation(until: number): void {
    this.automationReadyAt = Math.max(this.automationReadyAt, until);
    this.nextAutosellAt = Math.max(this.nextAutosellAt, until);
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
    this.inventoryKnown = true;
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
