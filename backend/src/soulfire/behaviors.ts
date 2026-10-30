import { isBlockedAfkCommand, AFK_BLOCK_MESSAGE } from "../minecraft/slashCommands.js";
import { readMultiplier, tooltipText } from "../minecraft/sellMultipliers.js";
import { parseSellEarning } from "../minecraft/sellEarnings.js";

export type BehaviorConfig = { crouch_enabled?: boolean; auto_button?: "off" | "left" | "right"; autosell_enabled?: boolean;
  autosell_interval_seconds?: number; autosell_command?: string; spawner_type?: string; spawner_drop_items?: string[]; spawner_sell_items?: string[] };
export type GameSlot = { slot: number; itemId: string; count: number; displayName: string; tooltipLines: string[] };
export type GameInventory = { menuId: string; title: string; containerSlots: number[]; playerSlots: number[]; slots: GameSlot[] };
export interface GameGateway {
  nativeAutosell?: boolean;
  suspendSell?(durationMs: number): Promise<void>;
  remote?(active: boolean): Promise<void>;
  held(config: BehaviorConfig): Promise<void>;
  sneak(): Promise<void>;
  chat(text: string): Promise<void>;
  inventory(): Promise<GameInventory>;
  click(menu: string, slot: number, action: "transfer" | "drop" | "left"): Promise<void>;
  transferAll?(menu: string): Promise<void>;
  close(menu: string): Promise<void>;
  openSpawner(crouch: boolean): Promise<boolean>;
}
export type BotOutput = (event: Record<string, unknown>) => void;
type Sell = { requested: number; opened: number | null; menu: string | null; targets: number[] | null; pending: { slot: GameSlot; batch?: GameSlot[]; at: number; confirmed: boolean } | null };
type Foreground = { kind: "multipliers" | "spawner"; deadline: number; opened: number | null; menu: string | null; previousMenu: string; phase: "drop" | "sell"; next: number;
  pending: { fingerprint: string; slot?: GameSlot; at: number; confirmed: boolean } | null };
const plain = (text: string) => tooltipText(text).trim();
const sellTitle = (text: string) => /^(items verkaufen|sell)$/i.test(plain(text));
const teleportSuccess = (text: string) => /^(?:<(?:HugoSMP)>|\[HugoSMP\])?\s*(?:Du wurdest zu deinem Home .+ teleportiert!|[^:]+ hat deine Teleportations-Anfrage angenommen!|Du hast die Teleportations-Anfrage von .+ angenommen!)$/i.test(plain(text));

/** One serialized scheduler for both editions. Deadlines are finite and
 * independent of inventory traffic; transitions always clear stale ownership. */
export class SoulFireBehaviors {
  private cfg: BehaviorConfig;
  private online = false;
  private remoteActive = false;
  private readyAt = 0;
  private nextSell = 0;
  private pauseStart = 0;
  private pauseEnd = 0;
  private manualUntil = 0;
  private nextSneak = 0;
  private sneakChecks: number[] = [];
  private commands: Array<{ type: string; text?: string }> = [];
  private sell: Sell | null = null;
  private foreground: Foreground | null = null;
  private commandCredits = 3;
  private creditAt = 0;
  private lastFailure = -Infinity;
  private generation = 0;

  constructor(config: BehaviorConfig, private game: GameGateway, private emit: BotOutput, private clock = Date.now) { this.cfg = { ...config }; }

  async configure(config: BehaviorConfig): Promise<void> {
    const changed = config.autosell_enabled !== this.cfg.autosell_enabled || config.autosell_interval_seconds !== this.cfg.autosell_interval_seconds || config.autosell_command !== this.cfg.autosell_command;
    this.cfg = { ...config };
    await this.game.held(this.cfg);
    if (!config.autosell_enabled) await this.cancelSell();
    if (changed) this.nextSell = this.clock();
  }

  async remote(active: boolean): Promise<void> {
    this.remoteActive = active;
    const owned = this.sell?.menu ?? this.foreground?.menu;
    this.resetTasks();
    if (owned) await this.closeOwned(owned);
    await this.game.remote?.(active);
    if (!active) { await this.game.held(this.cfg); this.nextSell = this.clock(); }
  }

  async spawned(): Promise<void> {
    this.online = true;
    this.transition();
    await this.game.held(this.cfg);
  }

  joining(): void { this.online = false; this.resetTasks(); }

  transition(): void {
    this.resetTasks();
    this.readyAt = this.clock() + 2000;
    this.nextSell = this.readyAt;
    this.nextSneak = 0;
    this.scheduleSneak();
  }

  pause(afterMs: number, resumeMs: number): void {
    const now = this.clock(); this.pauseStart = now + afterMs; this.pauseEnd = now + resumeMs;
    if (resumeMs === 0) this.pauseStart = this.pauseEnd = 0;
  }

  enqueue(type: string, text?: string): void {
    if (type === "clean_spawner" && this.commands.some(command => command.type === type)) return;
    this.commands.push({ type, text });
  }

  checkSneak(): void { if (this.cfg.crouch_enabled) this.nextSneak = 0; }

  onChat(sender: string | null, message: string): void {
    if (sender && sender.toLowerCase() !== "hugosmp") return;
    if (teleportSuccess(message)) { this.scheduleSneak(); this.nextSneak = 0; }
    // A hopper can refill the same slot before the next snapshot. A genuine
    // server payout still confirms that pending transfer; unchanged counts
    // alone must not turn a successful sale into a timeout.
    if (/^(?:\[HugoSMP\]|<HugoSMP>)?\s*\+\$/i.test(plain(message)) && parseSellEarning(message) !== null) {
      if (this.sell?.pending) this.sell.pending.confirmed = true;
      if (this.foreground?.kind === "spawner" && this.foreground.phase === "sell" && this.foreground.pending) this.foreground.pending.confirmed = true;
    }
    const text = plain(message).toLowerCase();
    if ((text.includes("inventar") || text.includes("inventory")) && /geladen|gespeichert|saving|loading/.test(text)) {
      this.resetTasks(); this.readyAt = this.clock() + 1000; this.nextSell = this.readyAt;
    }
  }

  private scheduleSneak(): void {
    const due = this.clock() + 3000;
    if (due - (this.sneakChecks.at(-1) ?? -Infinity) >= 50) this.sneakChecks.push(due);
    if (this.sneakChecks.length > 64) this.sneakChecks.shift();
  }

  private resetTasks(): void { this.generation++; this.sell = null; this.foreground = null; }

  async tick(): Promise<void> {
    const now = this.clock();
    if (!this.online || this.remoteActive) return;
    while (this.sneakChecks.length && this.sneakChecks[0] <= now) { this.sneakChecks.shift(); this.checkSneak(); }
    if (this.cfg.crouch_enabled && now >= this.nextSneak) {
      try { await this.game.sneak(); this.nextSneak = now + 30 * 60_000; }
      catch { this.nextSneak = now + 1000; } // Checks are intentionally silent.

    }
    if (this.commands.length) {
      const command = this.commands[0];
      if (!this.creditReady(now)) return;
      this.commands.shift();
      try { await this.runCommand(command); }
      catch (error) {
        this.emit({ type: "warning", message: `Befehl ${command.text ?? command.type} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}. Bei einem Timeout vor erneutem Senden die Serverantwort prüfen.` });
      }
      return;
    }
    const paused = now >= this.pauseStart && now < this.pauseEnd;
    if (paused) { await this.cancelSell(); return; }
    if (now < this.readyAt) return;
    if (this.foreground) { await this.tickForeground(now); return; }
    if (!this.cfg.autosell_enabled || now < this.manualUntil) return;
    if (!this.game.nativeAutosell) await this.tickSell(now);
  }

  private creditReady(now: number): boolean {
    if (!this.creditAt) this.creditAt = now;
    const credits = Math.floor((now - this.creditAt) / 1500);
    if (credits > 0) { this.commandCredits = Math.min(3, this.commandCredits + credits); this.creditAt += credits * 1500; }
    return this.commandCredits >= 1;
  }

  private async dispatch(text: string, automatic = false): Promise<void> {
    if (isBlockedAfkCommand(text)) { this.emit({ type: "warning", message: AFK_BLOCK_MESSAGE }); throw new Error("/afk ist gesperrt"); }
    await this.game.chat(text);
    if (!automatic) this.commandCredits--;
  }

  private async runCommand(command: { type: string; text?: string }): Promise<void> {
    await this.game.suspendSell?.(5000);
    const generation = this.generation;
    this.sell = null;
    this.foreground = null;
    const inventory = await this.game.inventory().catch(error => {
      // Typed commands need no inventory snapshot. Keep menu-dependent tasks
      // strict, but don't discard /home etc. during a telemetry resync.
      if (this.game.nativeAutosell && command.type === "chat") return { menuId: "", containerSlots: [] };
      throw error;
    });
    if (inventory.containerSlots.length) await this.game.close(inventory.menuId);
    this.manualUntil = this.clock() + 5000;
    if (command.type === "read_sell_multipliers") {
      await this.dispatch("/sellmulti");
      if (generation !== this.generation) return;
      const now = this.clock();
      this.foreground = { kind: "multipliers", deadline: now + 10_000, opened: null, menu: null, previousMenu: inventory.menuId, phase: "drop", pending: null, next: now };
    } else if (command.type === "clean_spawner") {
      if (!await this.game.openSpawner(!!this.cfg.crouch_enabled)) { this.emit({ type: "warning", message: "CleanSpawner: kein erreichbarer Spawner gefunden" }); return; }
      if (generation !== this.generation) return;
      const now = this.clock();
      this.foreground = { kind: "spawner", deadline: now + 60_000, opened: null, menu: null, previousMenu: inventory.menuId, phase: "drop", pending: null, next: now + 400 };
    } else if (command.text) {
      await this.dispatch(command.text);
      this.manualUntil = this.clock() + 5000;
      if (/^\/(?:tpaccept|tpyes)(?:\s|$)/i.test(command.text)) this.scheduleSneak();
      this.emit({ type: "behavior_log", message: `Command dispatched: ${command.text}` });
    }
  }

  private async tickSell(now: number): Promise<void> {
    if (!this.sell && now < this.nextSell) return;
    // Fetch current menu identity and slots, never a snapshot from before TP.
    const generation = this.generation;
    const inventory = await this.game.inventory();
    if (generation !== this.generation) return;
    now = this.clock();
    if (!this.sell && inventory.containerSlots.length) {
      // Only a known late sale GUI may be recovered. Manual/foreign menus stay open.
      if (sellTitle(inventory.title)) { await this.game.close(inventory.menuId); this.nextSell = now + 500; }
      return;
    }
    if (!this.sell) {
      if (now < this.nextSell) return;
      const sale: Sell = { requested: now, opened: null, menu: null, targets: null, pending: null };
      this.sell = sale;
      try { await this.dispatch((this.cfg.autosell_command || "/sell").trim(), true); }
      catch (error) { if (this.sell === sale) { this.sell = null; this.nextSell = this.clock() + 5000; } throw error; }
      if (this.sell !== sale || generation !== this.generation) return;
      sale.requested = this.clock();
      this.nextSell = now + Math.max(250, (this.cfg.autosell_interval_seconds ?? 60) * 1000);
      return;
    }
    const sale = this.sell;
    if (sale.opened === null && now - sale.requested >= 10_000) { await this.failSell("Verkaufsmenü hat nicht rechtzeitig geantwortet"); return; }
    if (sale.opened !== null && now - sale.opened >= 120_000) { await this.failSell("Zeitlimit für diesen Verkauf erreicht"); return; }
    if (!inventory.containerSlots.length) {
      if (sale.menu) { this.sell = null; this.nextSell = Math.max(this.nextSell, now); }
      return;
    }
    if (!sellTitle(inventory.title)) { this.sell = null; return; }
    if (sale.menu && sale.menu !== inventory.menuId) { this.sell = null; return; }
    if (!sale.menu) { sale.menu = inventory.menuId; sale.opened = now; }
    const populated = inventory.slots.filter(slot => inventory.playerSlots.includes(slot.slot) && slot.count > 0).map(slot => slot.slot);
    // A newly opened menu can arrive before its content packet. A genuinely
    // empty inventory receives the same bounded loading window.
    if (!sale.targets && !populated.length && now - sale.opened! < 500) return;
    sale.targets ??= populated;
    if (sale.pending) {
      const before = sale.pending.batch ?? [sale.pending.slot];
      const unchanged = before.every(previous => {
        const current = inventory.slots.find(slot => slot.slot === previous.slot);
        return current && current.itemId === previous.itemId && current.count >= previous.count;
      });
      if (!sale.pending.confirmed && unchanged) {
        if (now - sale.pending.at >= 5000) await this.failSell("Item-Transfer wurde nicht bestätigt");
        return;
      }
      sale.pending = null;
    }
    if (this.game.transferAll && sale.targets.length) {
      const items = inventory.slots.filter(slot => sale.targets!.includes(slot.slot) && slot.count > 0);
      sale.targets = [];
      if (!items.length) { await this.cancelSell(); return; }
      const pending = { slot: { ...items[0] }, batch: items.map(item => ({ ...item })), at: now, confirmed: false };
      sale.pending = pending;
      try {
        // One game-thread action sends all ordinary shift-clicks. The server
        // still owns acceptance/payouts; the next pass retries remaining stock.
        await this.game.transferAll(inventory.menuId);
        if (this.sell === sale && sale.pending === pending) pending.at = this.clock();
      } catch { if (this.sell === sale && !pending.confirmed) await this.failSell("Item-Transfer wurde abgelehnt"); }
      return;
    }
    const slotIndex = sale.targets.shift();
    if (slotIndex === undefined) { await this.cancelSell(); return; }
    const item = inventory.slots.find(slot => slot.slot === slotIndex && slot.count > 0);
    if (!item) return;
    const pending = { slot: { ...item }, at: now, confirmed: false };
    sale.pending = pending;
    try {
      await this.game.click(inventory.menuId, item.slot, "transfer");
      if (this.sell === sale && sale.pending === pending) pending.at = this.clock();
    } catch { if (this.sell === sale && !pending.confirmed) await this.failSell("Item-Transfer wurde abgelehnt"); }
  }

  private async tickForeground(now: number): Promise<void> {
    const task = this.foreground!;
    if (now < task.next) return;
    const inventory = await this.game.inventory();
    if (this.foreground !== task) return;
    now = this.clock();
    if (now >= task.deadline) {
      if (task.menu) await this.closeOwned(task.menu);
      this.foreground = null;
      this.emit({ type: "warning", message: task.kind === "multipliers" ? "Desmo: SELL MULTI nicht vollständig lesbar (10s Timeout)" : "CleanSpawner: Zeitlimit erreicht; Menü geschlossen" });
      return;
    }
    if (!inventory.containerSlots.length) { if (task.menu) this.foreground = null; return; }
    if (inventory.menuId === task.previousMenu) return;
    if (task.menu && task.menu !== inventory.menuId) { this.foreground = null; return; }
    if (!task.menu) { task.menu = inventory.menuId; task.opened = now; }
    if (task.kind === "multipliers") {
      if (!/^sell multi$/i.test(plain(inventory.title))) return;
      const entries = inventory.containerSlots.slice(0, 9).map(index => {
        const slot = inventory.slots.find(item => item.slot === index);
        return slot ? readMultiplier(slot.displayName, slot.tooltipLines) : null;
      });
      if (entries.length === 9 && entries.every(Boolean)) {
        await this.game.close(inventory.menuId); this.foreground = null;
        this.emit({ type: "sell_multipliers", entries });
      }
      return;
    }
    const stock = inventory.slots.filter(slot => inventory.containerSlots.includes(slot.slot) && slot.count > 0);
    if (!stock.length && now - task.opened! < 1000) return;
    const names = task.phase === "drop" ? this.cfg.spawner_drop_items ?? [] : this.cfg.spawner_sell_items ?? [];
    const matching = this.cfg.spawner_type ? stock.filter(slot => names.includes(slot.itemId)) : [...stock].sort((a, b) => b.slot - a.slot);
    const legacyDone = !this.cfg.spawner_type && !stock.some(slot => slot.slot === inventory.containerSlots[2]);
    const fingerprint = matching.map(slot => `${slot.slot}:${slot.itemId}:${slot.count}`).join("|");
    if (task.pending) {
      const before = task.pending.slot;
      const current = before && stock.find(slot => slot.slot === before.slot);
      const unchanged = before ? current && current.itemId === before.itemId && current.count >= before.count
        : fingerprint === task.pending.fingerprint;
      if (unchanged && !task.pending.confirmed) {
        if (now - task.pending.at >= 5000) {
          await this.closeOwned(inventory.menuId); this.foreground = null;
          this.emit({ type: "warning", message: "CleanSpawner: Änderung wurde nicht bestätigt; Vorgang abgebrochen" });
        }
        return;
      }
      task.pending = null;
    }
    // Preserve one stack of EACH selected item, rather than one stack across
    // all item types combined (e.g. both beef and leather).
    const counts = new Map<string, number>();
    for (const slot of matching) counts.set(slot.itemId, (counts.get(slot.itemId) ?? 0) + 1);
    const eligible = this.cfg.spawner_type ? matching.filter(slot => counts.get(slot.itemId)! > 1) : matching;
    if (this.cfg.spawner_type ? eligible.length === 0 : legacyDone || matching.length === 0) {
      if (task.phase === "drop" && this.cfg.spawner_type) { task.phase = "sell"; }
      else { await this.game.close(inventory.menuId); this.foreground = null; this.emit({ type: "behavior_log", message: "Spawner aufgeräumt; Menü geschlossen" }); }
      return;
    }
    if (task.phase === "drop") {
      task.pending = { fingerprint, slot: { ...eligible[0] }, at: now, confirmed: false };
      await this.game.click(inventory.menuId, eligible[0].slot, "drop");
    }
    else {
      const configuredStock = [...this.cfg.spawner_drop_items ?? [], ...this.cfg.spawner_sell_items ?? []];
      const sellButton = stock.find(slot => !configuredStock.includes(slot.itemId) && /verkaufen|sell/i.test([slot.displayName, ...slot.tooltipLines].map(plain).join(" ")));
      if (sellButton) {
        task.pending = { fingerprint, at: now, confirmed: false };
        await this.game.click(inventory.menuId, sellButton.slot, "left");
      }
    }
    if (task.pending) task.pending.at = this.clock();
    task.next = this.clock() + 400;
  }

  private async closeOwned(menu: string): Promise<void> {
    const inventory = await this.game.inventory();
    if (inventory.menuId === menu && inventory.containerSlots.length) await this.game.close(menu);
  }

  private async cancelSell(): Promise<void> {
    const sale = this.sell; this.sell = null;
    if (sale?.menu) await this.closeOwned(sale.menu);
  }

  private async failSell(reason: string): Promise<void> {
    await this.cancelSell(); this.nextSell = this.clock();
    if (this.clock() - this.lastFailure >= 30_000) { this.lastFailure = this.clock(); this.emit({ type: "warning", message: `AutoSell: ${reason}; versuche es weiter` }); }
  }
}
