import { BotSender } from "./send.js";
import { emit } from "./protocol.js";
import { readMultiplier, tooltipText, type SellMultiplier } from "../minecraft/sellMultipliers.js";

export type BedrockItem = { network_id: number; count?: number; stack_id?: number; [key: string]: unknown };
type WindowId = number | string;
type Container = { id: WindowId; type: string; items: BedrockItem[] | null; owned: boolean; position: string | null; manual: boolean; title: string | null };
type Pending = { id: number; source: number; destination: number; item: BedrockItem; sentAt: number };
const SELL_MENU_TIMEOUT_MS = 500;
const empty = (): BedrockItem => ({ network_id: 0 });
const present = (item: BedrockItem | undefined): item is BedrockItem => !!item?.network_id && (item.count ?? 0) > 0;
const positionKey = (position: unknown): string | null => {
  const p = position as { x?: number; y?: number; z?: number } | null;
  return p && [p.x, p.y, p.z].every(Number.isFinite) ? `${p.x},${p.y},${p.z}` : null;
};
const sellTitle = (title: string) => ["items verkaufen", "sell"].includes(title.replace(/§./g, "").trim().toLowerCase());
const playerWindow = (id: WindowId) => id === 0 || id === "inventory";
const multiplierTitle = (title: string | null) => tooltipText(title).replace(/\s/g, "").toLowerCase() === "sellmulti";

function multiplierTooltip(item: BedrockItem): { name: unknown; lore: unknown[] } {
  if (!present(item)) return { name: '', lore: [] };
  const unwrap = (value: any): any => value && typeof value === "object" && "value" in value ? value.value : value;
  const tag = (item.extra as { nbt?: any } | undefined)?.nbt;
  const root = unwrap(tag?.nbt ?? tag);
  const display = unwrap(root?.display);
  const lore = unwrap(unwrap(display?.Lore));
  return { name: unwrap(display?.Name), lore: Array.isArray(lore) ? lore : [] };
}

function multiplierItem(item: BedrockItem): SellMultiplier | null {
  const { name, lore } = multiplierTooltip(item);
  return readMultiplier(name, lore);
}

const boundedText = (value: unknown) => Array.from(tooltipText(value).replace(/[\r\n]/g, ' ')).slice(0, 160).join('');

/** Only the sell command's own GUI is automated. Inventory pickup traffic never
 * postpones the loading deadline, so a busy farm cannot starve selling. */
export class BedrockInventory {
  private player: BedrockItem[] | null = null;
  private container: Container | null = null;
  private requestedAt: number | null = null;
  private targets: number[] | null = null;
  private pending: Pending | null = null;
  private nextRequestId = -1;
  private openedAt = 0;
  private manualGuardUntil = 0;
  private cancelledSellUntil = 0;
  private titles = new Map<string, string>();
  private lastFailureAt = -Infinity;
  private needsFullPlayerContent = false;
  private multiplierScan: { deadline: number; windowId: WindowId | null } | null = null;
  constructor(private sender: BotSender) {}

  get busy(): boolean { return this.requestedAt != null || !!this.container?.owned; }
  get blocked(): boolean { return !!this.container && !this.container.owned; }
  get synchronized(): boolean { return !this.needsFullPlayerContent; }
  get readingMultipliers(): boolean { return this.multiplierScan !== null; }
  requestMultipliers(now: number): void {
    this.manualGuardUntil = 0;
    this.multiplierScan = { deadline: now + 10_000, windowId: null };
  }
  request(now: number): void { this.cancelledSellUntil = 0; this.requestedAt = now; this.targets = null; }

  reset(): void {
    this.cancelMultiplierScan();
    this.titles.clear(); this.manualGuardUntil = 0; this.cancelledSellUntil = 0;
    this.player = null; this.container = null; this.requestedAt = null;
    this.targets = null; this.pending = null;
  }

  /** A lost inventory packet makes every cached stack potentially stale.
   * Slot deltas and late transfer acknowledgements cannot repair that baseline. */
  invalidateAfterDecodeFailure(): void {
    this.needsFullPlayerContent = true;
    this.player = null;
    this.interrupt();
    if (this.container) this.container.items = null;
    this.cancelledSellUntil = Date.now() + 10_000;
  }

  clearMenuTitles(): void { this.titles.clear(); }

  interrupt(closeForeign = false, manualSell = false): void {
    const scanOwned = this.container && this.multiplierScan?.windowId === this.container.id
      && (multiplierTitle(this.container.title) || this.container.items?.slice(0, 9).some(item => multiplierItem(item) !== null));
    this.cancelMultiplierScan();
    if (closeForeign) {
      this.manualGuardUntil = Date.now() + 5_000;
      this.cancelledSellUntil = manualSell ? 0 : this.busy ? Date.now() + 10_000 : this.cancelledSellUntil;
    }
    if (this.container && (this.container.owned || closeForeign || scanOwned)) this.close();
    this.requestedAt = null; this.targets = null; this.pending = null;
  }

  onOpen(packet: { window_id: WindowId; window_type: string; coordinates?: unknown }): void {
    const now = Date.now();
    const position = positionKey(packet.coordinates);
    const manual = now < this.manualGuardUntil;
    const title = position ? this.titles.get(position) : undefined;
    if (position) this.titles.delete(position);
    const recentRequest = this.requestedAt != null && now - this.requestedAt <= 5_000;
    const owned = !manual && packet.window_type === "container" && (recentRequest || (!!title && sellTitle(title)));
    this.container = { id: packet.window_id, type: packet.window_type, items: null, owned, position, manual, title: title ?? null };
    if (this.multiplierScan && packet.window_type === "container") this.multiplierScan.windowId = packet.window_id;
    this.openedAt = now; this.targets = null; this.pending = null;
    if (title && sellTitle(title) && now < this.cancelledSellUntil) this.close();
  }

  /** Geyser carries Java GUI titles in the fake chest's CustomName NBT.
   * This identifies a late/startup sell GUI even after a spawn reset. */
  onBlockEntity(packet: { position?: unknown; coordinates?: unknown; nbt?: unknown }): void {
    const position = positionKey(packet.position ?? packet.coordinates);
    const nbt = packet.nbt as { value?: { CustomName?: { value?: unknown } } } | undefined;
    const title = nbt?.value?.CustomName?.value;
    if (!position || typeof title !== "string") return;
    this.titles.delete(position);
    this.titles.set(position, title);
    if (this.titles.size > 16) this.titles.delete(this.titles.keys().next().value!);
    const menu = this.container;
    if (menu?.position === position) {
      menu.title = title;
      const recentRequest = this.requestedAt != null && Date.now() - this.requestedAt <= 5_000;
      menu.owned = menu.type === "container" && !menu.manual && (sellTitle(title) || recentRequest);
      this.titles.delete(position);
      if (sellTitle(title) && Date.now() < this.cancelledSellUntil) this.close();
    }
  }

  onClose(packet: { window_id: WindowId }): void {
    if (this.container?.id !== packet.window_id) return;
    if (this.multiplierScan?.windowId === packet.window_id) this.cancelMultiplierScan();
    this.container = null; this.requestedAt = null; this.targets = null; this.pending = null;
  }

  tickMultipliers(now: number): void {
    const scan = this.multiplierScan;
    if (!scan) return;
    const menu = this.container;
    const associated = menu && scan.windowId === menu.id && menu.type === "container";
    // A resource pack can draw the title using glyphs, and Geyser can pad the
    // chest. Only a pending /desmo request plus nine valid tooltips identifies it.
    const entries = associated && menu.items && menu.items.length >= 9 && menu.items.length <= 54 && menu.items.length % 9 === 0
      ? menu.items.slice(0, 9).map(multiplierItem) : [];
    if (entries.length === 9 && entries.every((entry): entry is SellMultiplier => entry !== null)) {
      this.multiplierScan = null;
      this.close();
      emit({ type: "sell_multipliers", entries });
      return;
    }
    if (now >= scan.deadline) {
      let detail = "kein Menü geöffnet";
      if (menu) {
        const items = menu.items?.slice(0, 9) ?? [];
        const readable = items.filter(item => multiplierItem(item) !== null).length;
        const first = items.findIndex(item => multiplierItem(item) === null);
        const tooltip = first >= 0 ? multiplierTooltip(items[first]) : null;
        detail = `Menü-ID ${menu.id} (erwartet ${scan.windowId}); Titel ${JSON.stringify(boundedText(menu.title))}; ${menu.items?.length ?? 0} GUI-Slots; Tooltips vollständig ${readable}/9`;
        if (tooltip) detail += `; Slot ${first + 1}: Name ${JSON.stringify(boundedText(tooltip.name))}, Lore ${JSON.stringify(tooltip.lore.slice(0, 6).map(boundedText))}`;
      }
      this.multiplierScan = null;
      if (associated && (multiplierTitle(menu.title) || entries.some(entry => entry !== null))) this.close();
      emit({ type: "warning", message: `Desmo: SELL MULTI nicht vollständig lesbar (10s Timeout); ${detail}; keine unvollständigen Ergebnisse ausgegeben` });
    }
  }

  private cancelMultiplierScan(): void {
    if (this.multiplierScan) emit({ type: "warning", message: "Desmo: Auslesen durch neuen Command oder Weltwechsel abgebrochen" });
    this.multiplierScan = null;
  }

  onContent(packet: { window_id: WindowId; input: BedrockItem[] }): void {
    if (!Array.isArray(packet.input)) return;
    if (playerWindow(packet.window_id)) {
      if (this.needsFullPlayerContent && packet.input.length < 36) return;
      this.player = packet.input.map(item => ({ ...item }));
      this.needsFullPlayerContent = false;
    }
    else if (this.container?.id === packet.window_id) this.container.items = packet.input.map(item => ({ ...item }));
    this.confirmLegacyTransfer();
  }

  onSlot(packet: { window_id: WindowId; slot: number; item: BedrockItem }): void {
    if (!Number.isInteger(packet.slot) || packet.slot < 0 || packet.slot >= 256) return;
    if (playerWindow(packet.window_id)) {
      if (this.needsFullPlayerContent) return;
      // A slot update can precede the initial content packet during join.
      this.player ??= Array.from({ length: 36 }, empty);
      this.player[packet.slot] = { ...packet.item };
    } else if (this.container?.id === packet.window_id) {
      // Keep an unknown container unready until its full content arrives.
      if (this.container.items) this.container.items[packet.slot] = { ...packet.item };
    }
    this.confirmLegacyTransfer();
  }

  onResponse(packet: { responses?: Array<{ request_id: number; status: string; containers?: Array<{
    slot_type: { container_id: string } | string; slots: Array<{ slot: number; count: number; item_stack_id: number }>;
  }> }> }): void {
    for (const response of packet.responses ?? []) {
      const pending = this.pending;
      if (!pending || pending.id !== response.request_id) continue;
      if (response.status !== "ok") {
        // A sell menu can refuse tools/non-sellable items. Continue with other
        // slots instead of letting one rejected hotbar item block every sale.
        this.pending = null;
        this.logFailure("Server hat einen Item-Transfer abgelehnt; überspringe diesen Slot");
        continue;
      }
      for (const container of response.containers ?? []) {
        const kind = typeof container.slot_type === "string" ? container.slot_type : container.slot_type.container_id;
        const items = ["inventory", "hotbar", "hotbar_and_inventory"].includes(kind) ? this.player
          : kind === "container" ? this.container?.items : null;
        if (!items) continue;
        for (const slot of container.slots) {
          // For hotbar_and_inventory, slots 0..35 use the inventory ordering.
          if (slot.slot < 0 || slot.slot >= items.length) continue;
          if (slot.count === 0) items[slot.slot] = empty();
          else items[slot.slot] = { ...pending.item, count: slot.count, stack_id: slot.item_stack_id, has_stack_id: 1 };
        }
      }
      // Never predict depletion over a pickup packet received during this request.
      // The response's counts and network IDs, or subsequent inventory packets,
      // are authoritative. Finish this slot once; new pickups wait for next cycle.
      this.pending = null;
    }
  }

  tick(now: number): void {
    if (this.needsFullPlayerContent) return;
    if (!this.busy) return;
    const menu = this.container;
    if (!menu?.owned) {
      if (this.requestedAt != null && now - this.requestedAt >= SELL_MENU_TIMEOUT_MS) this.interrupt();
      return;
    }
    if (now - this.openedAt >= 10_000) { this.fail("Verkaufsmenü/Inventar nicht vollständig bestätigt (10s Timeout)"); return; }
    if (this.pending) {
      if (now - this.pending.sentAt >= 2_000) this.fail("Item-Transfer nicht bestätigt (2s Timeout)");
      return;
    }
    if (!menu.items || !this.player) return;
    this.targets ??= Array.from({ length: Math.min(36, this.player.length) }, (_, i) => i).filter(i => present(this.player![i]));
    while (this.targets.length) {
      const source = this.targets.shift()!;
      const item = this.player[source];
      if (!present(item)) continue;
      // Empty destinations avoid merging stacks with unknown server stack limits.
      const destination = menu.items.findIndex(item => !present(item));
      if (destination < 0) { this.close(); return; }
      const requestId = this.nextRequestId--;
      const count = Math.min(255, item.count!);
      let sent: boolean;
      if (this.sender.authoritativeInventory) {
        if (!Number.isInteger(item.stack_id) || item.stack_id! <= 0) { this.fail("Stack-ID fehlt; warte auf Inventarsynchronisation"); return; }
        const slot = (container_id: string, index: number, stack_id: number) => ({
          slot_type: { container_id }, slot: index, stack_id,
        });
        sent = this.sender.packet("item_stack_request", { requests: [{ request_id: requestId,
          actions: [{ type_id: "place", count,
            source: slot("hotbar_and_inventory", source, item.stack_id!),
            destination: slot("container", destination, 0) }],
          custom_names: [], cause: "chat_public",
        }] });
      } else {
        sent = this.sender.packet("inventory_transaction", { transaction: {
          legacy: { legacy_request_id: 0 }, transaction_type: "normal", actions: [
            { source_type: "container", inventory_id: "inventory", slot: source, old_item: item, new_item: empty() },
            { source_type: "container", inventory_id: menu.id, slot: destination, old_item: empty(), new_item: item },
          ],
        } });
      }
      if (!sent) { this.fail("Item-Transfer konnte nicht gesendet werden"); return; }
      this.pending = { id: requestId, source, destination, item: { ...item }, sentAt: now };
      return;
    }
    this.close();
  }

  private confirmLegacyTransfer(): void {
    if (!this.pending || this.sender.authoritativeInventory) return;
    if (!present(this.player?.[this.pending.source]) && present(this.container?.items?.[this.pending.destination])) this.pending = null;
  }

  private close(): void {
    if (this.container) this.sender.packet("container_close", {
      window_id: this.container.id, window_type: this.container.type, server: false,
    });
    this.container = null; this.requestedAt = null; this.targets = null; this.pending = null;
  }

  private logFailure(reason: string): void {
    if (Date.now() - this.lastFailureAt >= 30_000) {
      this.lastFailureAt = Date.now();
      emit({ type: "behavior_log", message: `Bedrock AutoSell: ${reason}; versuche es weiter` });
    }
  }

  private fail(reason: string): void {
    this.logFailure(reason);
    this.interrupt();
  }
}
