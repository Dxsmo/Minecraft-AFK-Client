//! Behavior engine for the Bedrock bot: the periodic tick loop plus the
//! task-interrupt system, mirroring the Azalea bot's behavior model so the
//! Node backend gets the same events regardless of edition.
//!
//! Continuous auto-sell yields to
//! one-shot foreground tasks (manual command):
//! while a foreground task is running, auto-sell does not start, and it resumes
//! on the next tick once the foreground task has completed. Foreground tasks run
//! one at a time, so no two Minecraft actions race each other.

import { emit, type BehaviorConfig, type Config, type OutEvent } from "./protocol.js";
import { BotSender } from "./send.js";
import { BedrockInventory } from "./inventory.js";
import { BedrockAutoButton } from "./autoButton.js";

/** Emit a heartbeat at most this often. */
const HEARTBEAT_INTERVAL_MS = 15000;
const SPAWN_STABILIZE_MS = 250;
const TELEPORT_STABILIZE_MS = 100;
const TELEPORT_COMMAND_GUARD_MS = 750;
const CHAT_COMMAND_GUARD_MS = 100;
const INVENTORY_BUSY_DELAY_MS = 250;

type ForegroundTask =
  | { kind: "command"; text: string }
  | { kind: "sell_multipliers" }
  | { kind: "clean_spawner" };

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
  readonly inventory: BedrockInventory;
  readonly autoButton: BedrockAutoButton;
  private nextCrouchCheckAt = 0;
  private teleportCrouchChecks: number[] = [];
  private manualAutosellPauseUntil = 0;
  private cfg: BehaviorConfig;

  private spawned = false;
  private lastHeartbeatAt = 0;
  private nextAutosellAt = Date.now();
  private restartPauseStart = 0;
  private restartPauseEnd = 0;
  private automationReadyAt = Number.POSITIVE_INFINITY;

  private manualQueue: ForegroundTask[] = [];
  private queue: ForegroundTask[] = [];

  private sneaking = false;
  private serverSneaking: boolean | null = null;
  private crouchResyncGraceUntil = 0;
  private crouchResyncPending = false;

  constructor(config: Config, sender: BotSender) {
    this.sender = sender;
    this.inventory = new BedrockInventory(sender);
    this.autoButton = new BedrockAutoButton(sender, this.inventory, config.version || "1.26.51");
    this.autoButton.configure(config.auto_button);
    sender.mouseInput = () => this.autoButton.tick(Date.now());
    this.pauseAutosell(config.autosell_pause_after_ms ?? 0, config.autosell_resume_after_ms ?? 0);
    this.cfg = {
      crouch_enabled: config.crouch_enabled ?? false,
      auto_button: config.auto_button ?? "off",
      autosell_enabled: config.autosell_enabled ?? false,
      autosell_interval_seconds: config.autosell_interval_seconds ?? 60,
      autosell_command: config.autosell_command ?? "/sell",
    };
  }

  pauseAutosell(afterMs: number, resumeMs: number): void {
    const now = Date.now();
    this.restartPauseStart = now + afterMs;
    this.restartPauseEnd = now + resumeMs;
  }

  updateConfig(cfg: BehaviorConfig): void {
    const wasCrouch = this.cfg.crouch_enabled;
    const autosellChanged =
      this.cfg.autosell_enabled !== cfg.autosell_enabled ||
      this.cfg.autosell_interval_seconds !== cfg.autosell_interval_seconds ||
      this.cfg.autosell_command !== cfg.autosell_command;
    this.cfg = { ...cfg };
    this.autoButton.configure(cfg.auto_button);
    if (!cfg.autosell_enabled) this.inventory.interrupt();
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
    this.serverSneaking = null;
  }

  markJoining(): void {
    this.autoButton.reset();
    this.inventory.reset();
    this.spawned = false;
    this.crouchResyncPending = true;
    this.serverSneaking = null;
    this.automationReadyAt = Number.POSITIVE_INFINITY;
  }

  markTeleported(): void {
    this.autoButton.teleported();
    this.scheduleTeleportCrouchCheck(Date.now());
    this.inventory.interrupt();
    this.spawned = true;
    this.automationReadyAt = Date.now() + TELEPORT_STABILIZE_MS;
    this.nextAutosellAt = this.automationReadyAt;
    this.crouchResyncPending = true;
    this.serverSneaking = null;
  }

  // --- Foreground task enqueue (called from stdin command handling) ---

  enqueueChat(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.manualQueue.push({ kind: "command", text: trimmed });
  }
  enqueueCleanSpawner(): void {
    this.queue.push({ kind: "clean_spawner" });
  }
  enqueueSellMultipliers(): void {
    this.manualQueue.push({ kind: "sell_multipliers" });
  }

  // --- Periodic tick, driven by index.ts ---

  onTick(): void {
    const now = Date.now();
    let actionSentThisTick = false;
    while (this.spawned && this.teleportCrouchChecks.length && now >= this.teleportCrouchChecks[0]) {
      this.teleportCrouchChecks.shift();
      this.checkCrouch();
    }

    if (now - this.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      this.lastHeartbeatAt = now;
      emit({ type: "heartbeat" });
    }

    // World switches/teleports may clear server input while our local value
    // remains true. Re-send start_sneak after the destination has settled.
    if (this.spawned && now >= this.automationReadyAt && this.cfg.crouch_enabled && (!this.sneaking || this.crouchResyncPending || now >= this.nextCrouchCheckAt)) {
      const resync = this.crouchResyncPending || this.serverSneaking === false;
      this.applyCrouch(true, resync);
      if (resync) this.crouchResyncGraceUntil = now + 2000;
      this.crouchResyncPending = false;
      this.nextCrouchCheckAt = now + 2000;
    }

    if (this.spawned) this.sender.tickInput();

    if (this.spawned && this.manualQueue.length) {
      this.runForeground(this.manualQueue.shift()!, now, true);
      return;
    }
    if (this.inventory.readingMultipliers) {
      this.inventory.tickMultipliers(now);
      return;
    }
    if (!this.spawned || now < this.automationReadyAt || now < this.manualAutosellPauseUntil) return;

    // Run at most one foreground task per tick.
    const task = this.queue.shift();
    if (task) {
      this.runForeground(task, now);
      actionSentThisTick = true;
    }

    // Continuous auto-sell yields to any foreground task.
    const sellPaused = now >= this.restartPauseStart && now < this.restartPauseEnd;
    if (sellPaused) this.inventory.interrupt();
    if (this.cfg.autosell_enabled && !actionSentThisTick && !sellPaused && this.inventory.synchronized) {
      this.inventory.tick(now);
      if (this.inventory.busy || this.inventory.blocked) return;
      const interval = Math.max(0.25, this.cfg.autosell_interval_seconds ?? 60) * 1000;
      if (now >= this.nextAutosellAt) {
        this.nextAutosellAt = now + interval;
        const command = (this.cfg.autosell_command ?? "/sell").trim() || "/sell";
        this.inventory.request(now);
        this.sender.command(command);
      }
    }
  }

  private runForeground(task: ForegroundTask, now: number, manual = false): void {
    switch (task.kind) {
      case "sell_multipliers":
        this.inventory.interrupt(true);
        this.inventory.requestMultipliers(now);
        this.sender.command("/sellmulti");
        this.postponeAutomation(now + CHAT_COMMAND_GUARD_MS);
        break;
      case "command":
        if (manual) this.manualAutosellPauseUntil = now + 5000;
        this.inventory.interrupt(true, task.text.trim() === (this.cfg.autosell_command ?? "/sell").trim());
        this.sender.send(task.text);
        if (/^\/(?:tpaccept|tpyes)(?:\s|$)/i.test(task.text.trim())) this.scheduleTeleportCrouchCheck(now);
        this.postponeAutomation(
          now + (isTeleportCommand(task.text) ? TELEPORT_COMMAND_GUARD_MS : CHAT_COMMAND_GUARD_MS),
        );
        emit({ type: "behavior_log", message: `Command dispatched: ${task.text}` });
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

    const plain = message.replace(/§./g, "").replace(/^(?:<HugoSMP>|\[HugoSMP\])\s*/, "").trim();
    if ((!sender || sender.toLowerCase() === "hugosmp") && (
      /^Du wurdest zu deinem Home .+ teleportiert!$/.test(plain) ||
      /^[^:]+ hat deine Teleportations-Anfrage angenommen!$/.test(plain) ||
      /^Du hast die Teleportations-Anfrage von .+ angenommen!$/.test(plain)
    )) {
      this.crouchResyncPending = true;
      this.serverSneaking = null;
      this.scheduleTeleportCrouchCheck(now);
    }
    if (isInventoryBusyMessage(message)) {
      this.inventory.interrupt();
      this.postponeAutomation(now + INVENTORY_BUSY_DELAY_MS);
      return;
    }

  }

  private postponeAutomation(until: number): void {
    this.automationReadyAt = Math.max(this.automationReadyAt, until);
    this.nextAutosellAt = Math.max(this.nextAutosellAt, until);
  }

  onSneakStatus(sneaking: boolean): void {
    this.serverSneaking = sneaking;
    // Bound retries of negative feedback without ever releasing held sneak.
    if (!sneaking && this.cfg.crouch_enabled && Date.now() >= this.crouchResyncGraceUntil) {
      this.crouchResyncPending = true;
      this.nextCrouchCheckAt = Date.now();
    }
  }

  checkCrouch(): void {
    if (!this.cfg.crouch_enabled) return;
    this.crouchResyncPending = true;
    this.nextCrouchCheckAt = Date.now();
  }

  private scheduleTeleportCrouchCheck(now: number): void {
    const deadline = now + 3000;
    // Coalesce the same tick's command/chat/position notifications, while
    // retaining checks for successive teleports rather than postponing them.
    if (deadline - (this.teleportCrouchChecks.at(-1) ?? -Infinity) < 50) return;
    this.teleportCrouchChecks.push(deadline);
    if (this.teleportCrouchChecks.length > 64) this.teleportCrouchChecks.shift();
  }

  private applyCrouch(on: boolean, resync = false): void {
    this.sneaking = on;
    this.sender.setSneak(on, resync);
  }
}
