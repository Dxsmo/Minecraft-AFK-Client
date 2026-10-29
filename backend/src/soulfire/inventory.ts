import type { BotInventoryStateResponse } from "@soulfiremc/sdk/generated/soulfire/bot_pb";
import type { GameInventory } from "./behaviors.js";

/** Inventory events omit rendered icons. Never fall back to getInventoryState:
 * that RPC renders every occupied slot, even for background automation. */
export class SoulFireInventory {
  private current: GameInventory | null = null;

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
  }

  read(): GameInventory {
    if (!this.current) throw new Error("Inventar wird noch synchronisiert");
    return this.current;
  }
}
