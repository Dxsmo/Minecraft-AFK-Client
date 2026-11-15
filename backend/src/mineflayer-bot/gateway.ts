import type { Bot } from "mineflayer";
import type { Window } from "prismarine-windows";
import { simplify } from "prismarine-nbt";
import type { BehaviorConfig, GameGateway, GameInventory, GameSlot } from "../minecraft/behaviors.js";
import { tooltipText } from "../minecraft/sellMultipliers.js";

/** Window numbers are reused by servers. Pair them with the actual window
 * instance so a delayed task can never click a replacement menu. */
export class MineflayerGateway implements GameGateway {
  private windows = new WeakMap<Window, string>();
  private generation = 0;
  private cfg: BehaviorConfig = {};
  private buttonBusy = false;
  private nextButton = 0;

  constructor(private bot: Bot) {}

  private identity(window: Window): string {
    let id = this.windows.get(window);
    if (!id) { id = `${window.id}:${++this.generation}`; this.windows.set(window, id); }
    return id;
  }

  async inventory(): Promise<GameInventory> {
    const window = this.bot.currentWindow ?? this.bot.inventory;
    if (!window) throw new Error("Inventar wird noch synchronisiert");
    const container = !!this.bot.currentWindow;
    const slots: GameSlot[] = [];
    window.slots.forEach((item, slot) => {
      if (!item || item.count <= 0) return;
      // Prismarine's getters handle both legacy NBT and modern components.
      // NBT text components still need simplifying before tooltip parsing.
      const text = (value: unknown): string => {
        if (value && typeof value === "object" && "type" in value && "value" in value) {
          try { return tooltipText(simplify(value as Parameters<typeof simplify>[0])); } catch { /* Plain component below. */ }
        }
        return tooltipText(value);
      };
      const lore = item.customLore;
      slots.push({ slot, itemId: `minecraft:${item.name}`, count: item.count,
        displayName: text(item.customName) || item.displayName,
        tooltipLines: (Array.isArray(lore) ? lore : lore ? [lore] : []).map(text) });
    });
    return { menuId: this.identity(window), title: tooltipText(window.title),
      containerSlots: container ? Array.from({ length: window.inventoryStart }, (_, i) => i) : [],
      playerSlots: Array.from({ length: window.inventoryEnd - window.inventoryStart }, (_, i) => window.inventoryStart + i), slots };
  }

  private menu(id: string): Window {
    const window = this.bot.currentWindow;
    if (!window || this.identity(window) !== id) throw new Error("Menü wurde inzwischen geschlossen oder ersetzt");
    return window;
  }

  async click(id: string, slot: number, action: "transfer" | "drop" | "left"): Promise<void> {
    const window = this.menu(id);
    if (!Number.isInteger(slot) || slot < 0 || slot >= window.slots.length) throw new Error("Ungültiger Inventarplatz");
    await this.bot.clickWindow(slot, action === "drop" ? 1 : 0, action === "transfer" ? 1 : action === "drop" ? 4 : 0);
  }

  async close(id: string): Promise<void> { this.bot.closeWindow(this.menu(id)); }
  async chat(text: string): Promise<void> { this.bot.chat(text); }

  async held(config: BehaviorConfig): Promise<void> {
    const previous = this.cfg.auto_button;
    this.cfg = { ...config };
    this.bot.setControlState("sneak", !!config.crouch_enabled);
    if (previous !== config.auto_button) { this.bot.stopDigging(); if (this.bot.usingHeldItem) this.bot.deactivateItem(); }
    this.nextButton = 0;
  }

  async sneak(): Promise<void> {
    if (!this.cfg.crouch_enabled || !this.bot.entity || this.bot._client.state !== "play") return;
    this.bot.setControlState("sneak", true);
    // setControlState suppresses unchanged values. Reassert only the start
    // packet, never briefly release sneak during a check or teleport.
    if (this.bot.supportFeature("newPlayerInputPacket")) {
      this.bot._client.write("player_input", { inputs: { shift: true } });
    } else {
      this.bot._client.write("entity_action", { entityId: this.bot.entity.id,
        actionId: (this.bot.supportFeature as (feature: string) => boolean)("entityActionUsesStringMapper") ? "start_sneaking" : 0, jumpBoost: 0 });
    }
  }

  async openSpawner(crouch: boolean): Promise<boolean> {
    const block = this.bot.findBlock({ matching: b => /^(?:mob_)?spawner$/.test(b.name), maxDistance: 4 });
    if (!block) return false;
    // Sneaking consumes the interaction on many spawner plugins. Restore it
    // after dispatch even when the interaction fails.
    if (crouch) this.bot.setControlState("sneak", false);
    try { await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true); await this.bot.activateBlock(block); }
    finally { if (crouch) await this.sneak(); }
    return true;
  }

  /** Vanilla-like repeat intervals; no overlapping digs/use operations and no
   * background clicks into an automation or manually opened container. */
  async tickButton(now = Date.now()): Promise<void> {
    if (this.buttonBusy || this.bot.currentWindow || !this.bot.entity || this.bot._client.state !== "play"
      || !this.cfg.auto_button || this.cfg.auto_button === "off" || now < this.nextButton) return;
    this.nextButton = now + 250;
    this.buttonBusy = true;
    try {
      if (this.cfg.auto_button === "right") {
        const block = this.bot.blockAtCursor(4.5);
        if (block) await this.bot.activateBlock(block);
        else if (!this.bot.usingHeldItem) this.bot.activateItem();
      } else {
        const entity = this.bot.entityAtCursor(3);
        if (entity) { this.bot.attack(entity); this.nextButton = now + 625; }
        else {
          const block = this.bot.blockAtCursor(4.5);
          if (block && this.bot.canDigBlock(block)) await this.bot.dig(block, false);
          else this.bot.swingArm("right");
        }
      }
    } finally { this.buttonBusy = false; }
  }

  transition(): void { this.bot.stopDigging?.(); this.nextButton = 0; }
  suspendButton(): void {
    if (this.bot.targetDigBlock) this.bot.stopDigging();
    if (this.bot.usingHeldItem) this.bot.deactivateItem();
  }
  dispose(): void { this.cfg = {}; this.bot.stopDigging?.(); }
}
