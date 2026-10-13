import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BehaviorState } from "../../src/bedrock-bot/behaviors.js";
import type { BotSender } from "../../src/bedrock-bot/send.js";
import type { BedrockItem } from "../../src/bedrock-bot/inventory.js";
import { readMultiplier } from "../../src/minecraft/sellMultipliers.js";

const position = { x: 1, y: 64, z: 1 };
function item(index: number): BedrockItem {
  return { network_id: index + 1, count: 1, extra: { nbt: { version: 1, nbt: { type: "compound", value: {
    display: { type: "compound", value: { Name: { type: "string", value: `§dKategorie ${index}` },
      Lore: { type: "list", value: { type: "string", value: [`§7Aktueller Multiplikator: §a${index + 1}x`, "Fortschritt: $3.695 / $20.000", "§e████§8░░░░░░░░ 18%"] } } } },
  } } } } };
}
function setup(autosell = true) {
  const sender = { setSneak: vi.fn(), tickInput: vi.fn(), packet: vi.fn(() => true), command: vi.fn(), send: vi.fn() };
  const behavior = new BehaviorState({ host: "localhost", port: 19132, auth_type: "offline", username: "Bot", cache_dir: "",
    autosell_enabled: autosell, autosell_interval_seconds: 0.25 }, sender as unknown as BotSender);
  behavior.markSpawned(); vi.advanceTimersByTime(300);
  return { sender, behavior, inventory: behavior.inventory };
}
const events = () => vi.mocked(process.stdout.write).mock.calls.map(([line]) => JSON.parse(String(line)));
function open(inventory: BehaviorState["inventory"], title = "SELLMULTI", id = 3) {
  inventory.onBlockEntity({ position, nbt: { value: { CustomName: { value: title } } } });
  inventory.onOpen({ window_id: id, window_type: "container", coordinates: position });
}
describe("website-only multiplier scan", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(process.stdout, "write").mockImplementation(() => true); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("reads the screenshot and JSON/coloured decimal tooltips without treating progress as a multiplier", () => {
    expect(readMultiplier('§dFische', ['§7Aktueller Multiplikator: §a1x', 'Fortschritt: $3.695 / $20.000', '§e████§8░░░░░░ 18%'])).toEqual({ name: 'Fische', multiplier: '1x', progress: '3.695$/20.000$ - 18%' });
    expect(readMultiplier('{"text":"Erze","extra":[{"text":"!"}]}', ['{"text":"Current multiplier: 2.5×"}', 'Progress: 600$/800$ - 67%'])).toEqual({ name: 'Erze!', multiplier: '2.5×', progress: '600$/800$ - 67%' });
    expect(readMultiplier('Erze', ['Aktueller Multiplikator: 1,5x', 'Fortschritt: $600 / $800'])).toEqual({ name: 'Erze', multiplier: '1,5x', progress: '600$/800$ - 75%' });
    expect(readMultiplier('Fische', ['Fortschritt: 18%'])).toBeNull();
    expect(readMultiplier('Fische', ['Aktueller Multiplikator: 1x'])).toBeNull();
    expect(readMultiplier('Fische', ['Aktueller Multiplikator: 1x', 'Fortschritt: $0 / $0'])).toBeNull();
    expect(readMultiplier('Fische', ['Aktueller Multiplikator: 1x', 'Progress: $3,695 / $20,000'])).toEqual({ name: 'Fische', multiplier: '1x', progress: '3,695$/20,000$ - 18%' });
    expect(readMultiplier('Fische', ['Aktueller Multiplikator: 1x', 'Fortschritt: $3.695,50 / $20.000,00', '████ 18,47%'])).toEqual({ name: 'Fische', multiplier: '1x', progress: '3.695,50$/20.000,00$ - 18,47%' });
  });

  it.each([18, 27])("waits for every tooltip, closes the %s-slot menu and emits nine website results without clicks", size => {
    const { sender, behavior, inventory } = setup();
    behavior.enqueueSellMultipliers(); behavior.onTick();
    expect(sender.command).toHaveBeenCalledExactlyOnceWith('/sellmulti');
    open(inventory);
    const slots = Array.from({ length: size }, (_, index) => index < 8 ? item(index) : { network_id: 0 });
    inventory.onContent({ window_id: 3, input: slots }); behavior.onTick();
    expect(events().some(event => event.type === 'sell_multipliers')).toBe(false);
    expect(sender.packet).not.toHaveBeenCalled();
    inventory.onContent({ window_id: 'inventory', input: Array.from({ length: 36 }, (_, index) => item(index)) });
    behavior.onTick();
    expect(events().some(event => event.type === 'sell_multipliers')).toBe(false);
    inventory.onSlot({ window_id: 99, slot: 8, item: item(8) }); behavior.onTick();
    expect(events().some(event => event.type === 'sell_multipliers')).toBe(false);
    const incomplete = item(8) as any;
    incomplete.extra.nbt.nbt.value.display.value.Lore.value.value = ['Aktueller Multiplikator: 9x'];
    inventory.onSlot({ window_id: 3, slot: 8, item: incomplete }); behavior.onTick();
    expect(events().some(event => event.type === 'sell_multipliers')).toBe(false);
    expect(sender.packet).not.toHaveBeenCalled();
    inventory.onSlot({ window_id: 3, slot: 8, item: item(8) }); behavior.onTick();
    expect(sender.packet).toHaveBeenCalledExactlyOnceWith('container_close', { window_id: 3, window_type: 'container', server: false });
    expect(events().find(event => event.type === 'sell_multipliers')?.entries).toEqual(Array.from({ length: 9 }, (_, index) => ({ name: `Kategorie ${index}`, multiplier: `${index + 1}x`, progress: '3.695$/20.000$ - 18%' })));
    expect(sender.send).not.toHaveBeenCalled();
    behavior.onTick();
    expect(events().filter(event => event.type === 'sell_multipliers')).toHaveLength(1);
  });

  it("does not scan or close an ordinary /sellmulti menu", () => {
    const { sender, behavior, inventory } = setup();
    behavior.enqueueChat('/sellmulti'); behavior.onTick(); open(inventory);
    inventory.onContent({ window_id: 3, input: Array.from({ length: 18 }, (_, index) => index < 9 ? item(index) : { network_id: 0 }) });
    vi.advanceTimersByTime(11_000); behavior.onTick();
    expect(sender.send).toHaveBeenCalledExactlyOnceWith('/sellmulti');
    expect(sender.packet).not.toHaveBeenCalled();
    expect(events().some(event => event.type === 'sell_multipliers')).toBe(false);
  });

  it("accepts a delayed GUI title and closes only its own menu on timeout", () => {
    const { sender, behavior, inventory } = setup(false);
    behavior.enqueueSellMultipliers(); behavior.onTick();
    inventory.onOpen({ window_id: 3, window_type: 'container', coordinates: position });
    inventory.onContent({ window_id: 3, input: Array.from({ length: 18 }, (_, index) => index < 9 ? item(index) : { network_id: 0 }) });
    behavior.onTick(); expect(events().some(event => event.type === 'sell_multipliers')).toBe(false);
    inventory.onBlockEntity({ position, nbt: { value: { CustomName: { value: 'SELLMULTI' } } } }); behavior.onTick();
    expect(events().some(event => event.type === 'sell_multipliers')).toBe(true);
    sender.packet.mockClear();
    behavior.enqueueSellMultipliers(); behavior.onTick(); open(inventory, 'Homes', 4);
    vi.advanceTimersByTime(10_000); behavior.onTick();
    expect(sender.packet).not.toHaveBeenCalled();
    expect(events().filter(event => event.type === 'sell_multipliers')).toHaveLength(1);
    behavior.enqueueSellMultipliers(); behavior.onTick(); open(inventory);
    vi.advanceTimersByTime(10_000); behavior.onTick();
    expect(sender.packet).toHaveBeenLastCalledWith('container_close', { window_id: 3, window_type: 'container', server: false });
  });

  it("cancels on manual commands, world changes or an inventory decoding error", () => {
    const { sender, behavior, inventory } = setup(false);
    behavior.enqueueSellMultipliers(); behavior.onTick(); open(inventory);
    behavior.enqueueChat('/home'); behavior.onTick();
    expect(inventory.readingMultipliers).toBe(false);
    expect(sender.send).toHaveBeenCalledExactlyOnceWith('/home');
    behavior.enqueueSellMultipliers(); behavior.onTick(); behavior.markJoining();
    expect(inventory.readingMultipliers).toBe(false);
    behavior.markSpawned(); behavior.enqueueSellMultipliers(); behavior.onTick(); open(inventory);
    inventory.invalidateAfterDecodeFailure();
    expect(inventory.readingMultipliers).toBe(false);
    expect(events().some(event => event.type === 'sell_multipliers')).toBe(false);
  });
});
