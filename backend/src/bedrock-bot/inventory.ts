import { BotSender } from "./send.js";
import { emit } from "./protocol.js";

export type BedrockItem = { network_id: number; count?: number; stack_id?: number; [key: string]: unknown };
type WindowId = number | string;
type Container = { id: WindowId; type: string; items: BedrockItem[] | null; owned: boolean; position: string | null; manual: boolean };
type Pending = { id: number; source: number; destination: number; item: BedrockItem; sentAt: number };
const empty = (): BedrockItem => ({ network_id: 0 });
const present = (item: BedrockItem | undefined): item is BedrockItem => !!item?.network_id && (item.count ?? 0) > 0;
const positionKey = (position: unknown): string | null => {
  const p = position as { x?: number; y?: number; z?: number } | null;
  return p && [p.x, p.y, p.z].every(Number.isFinite) ? `${p.x},${p.y},${p.z}` : null;
};
const sellTitle = (title: string) => ["items verkaufen", "sell"].includes(title.replace(/§./g, "").trim().toLowerCase());
const playerWindow = (id: WindowId) => id === 0 || id === "inventory";

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
  private titles = new Map<string, string>();
  private lastFailureAt = -Infinity;
  constructor(private sender: BotSender) {}

  get busy(): boolean { return this.requestedAt != null || !!this.container?.owned; }
  get blocked(): boolean { return !!this.container && !this.container.owned; }
  request(now: number): void { this.requestedAt = now; this.targets = null; }

  reset(): void {
    this.titles.clear(); this.manualGuardUntil = 0;
    this.player = null; this.container = null; this.requestedAt = null;
    this.targets = null; this.pending = null;
  }

  interrupt(closeForeign = false): void {
    if (closeForeign) this.manualGuardUntil = Date.now() + 5_000;
    if (this.container && (this.container.owned || closeForeign)) this.close();
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
    this.container = { id: packet.window_id, type: packet.window_type, items: null, owned, position, manual };
    this.openedAt = now; this.targets = null; this.pending = null;
  }

  /** Geyser carries Java GUI titles in the fake chest's CustomName NBT.
   * This identifies a late/startup sell GUI even after a spawn reset. */
  onBlockEntity(packet: { coordinates?: unknown; nbt?: unknown }): void {
    const position = positionKey(packet.coordinates);
    const nbt = packet.nbt as { value?: { CustomName?: { value?: unknown } } } | undefined;
    const title = nbt?.value?.CustomName?.value;
    if (!position || typeof title !== "string") return;
    this.titles.delete(position);
    this.titles.set(position, title);
    if (this.titles.size > 16) this.titles.delete(this.titles.keys().next().value!);
    const menu = this.container;
    if (menu?.position === position) {
      const recentRequest = this.requestedAt != null && Date.now() - this.requestedAt <= 5_000;
      menu.owned = menu.type === "container" && !menu.manual && (sellTitle(title) || recentRequest);
      this.titles.delete(position);
    }
  }

  onClose(packet: { window_id: WindowId }): void {
    if (this.container?.id !== packet.window_id) return;
    this.container = null; this.requestedAt = null; this.targets = null; this.pending = null;
  }

  onContent(packet: { window_id: WindowId; input: BedrockItem[] }): void {
    if (!Array.isArray(packet.input)) return;
    if (playerWindow(packet.window_id)) this.player = packet.input.map(item => ({ ...item }));
    else if (this.container?.id === packet.window_id) this.container.items = packet.input.map(item => ({ ...item }));
    this.confirmLegacyTransfer();
  }

  onSlot(packet: { window_id: WindowId; slot: number; item: BedrockItem }): void {
    if (!Number.isInteger(packet.slot) || packet.slot < 0 || packet.slot >= 256) return;
    if (playerWindow(packet.window_id)) {
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
    if (!this.busy) return;
    const menu = this.container;
    if (!menu?.owned) {
      if (this.requestedAt != null && now - this.requestedAt >= 5_000) this.fail("kein Verkaufsmenü erhalten (5s Timeout)");
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
