import type { BotInventoryStateResponse } from "@soulfiremc/sdk/generated/soulfire/bot_pb";
import type { GameInventory } from "./behaviors.js";

/** Inventory events omit rendered icons. Never fall back to getInventoryState:
 * that RPC renders every occupied slot, even for background automation. */
export class SoulFireInventory {
  private current: GameInventory | null = null;
  private changes = new Set<() => void>();

  get ready(): boolean { return this.current !== null; }

  reset(): void { this.current = null; }

  update(state: BotInventoryStateResponse): void {
    const regions = state.layout?.regions ?? [];
    const indices = (matches: (id: string) => boolean) => regions.filter(region => matches(region.id))
      .flatMap(region => Array.from({ length: region.slotCount }, (_, index) => region.startIndex + index));
    this.current = {
      menuId: state.menuId,
      title: state.layout?.title ?? "",
      containerSlots: indices(id => id === "container"),
      playerSlots: indices(id => id === "player_inventory" || id === "player_hotbar"),
      slots: state.slots.map(slot => ({ slot: slot.slot, itemId: slot.itemId, count: slot.count,
        displayName: slot.displayName || "", tooltipLines: [...slot.tooltipLines] })),
    };
    for (const changed of this.changes) changed();
  }

  waitForContainer(previousMenu: string, signal: AbortSignal, timeoutMs = 2500): Promise<boolean> {
    const opened = () => !!this.current?.containerSlots.length && this.current.menuId !== previousMenu;
    if (signal.aborted) return Promise.resolve(false);
    if (opened()) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = (value: boolean) => {
        clearTimeout(timer); this.changes.delete(changed); signal.removeEventListener("abort", abort); resolve(value);
      };
      const changed = () => { if (opened()) finish(true); };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.changes.add(changed); signal.addEventListener("abort", abort, { once: true });
    });
  }

  read(): GameInventory {
    if (!this.current) throw new Error("Inventar wird noch synchronisiert");
    return this.current;
  }
}
