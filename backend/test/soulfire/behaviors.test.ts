import { describe, expect, it, vi } from "vitest";
import { SoulFireBehaviors, type BehaviorConfig, type GameGateway, type GameInventory, type GameSlot } from "../../src/soulfire/behaviors.js";

const slot = (slot: number, itemId = "minecraft:stone", count = 64): GameSlot => ({ slot, itemId, count, displayName: "Stone", tooltipLines: [] });
function fixture(config: BehaviorConfig = {}) {
  let now = 100_000;
  let inventory: GameInventory = { menuId: "player", title: "Inventory", containerSlots: [], playerSlots: [9, 10], slots: [] };
  const emit = vi.fn();
  const game: GameGateway = { held: vi.fn(async () => {}), sneak: vi.fn(async () => {}), chat: vi.fn(async () => {}),
    inventory: vi.fn(async () => structuredClone(inventory)), click: vi.fn(async () => {}), close: vi.fn(async () => {}), openSpawner: vi.fn(async () => true) };
  const engine = new SoulFireBehaviors(config, game, emit, () => now);
  return { engine, game, emit, advance: (ms: number) => { now += ms; }, inventory: (next: Partial<GameInventory>) => { inventory = { ...inventory, ...next }; },
    sellMenu: (id = "sell-1") => { inventory = { menuId: id, title: "§aItems verkaufen", containerSlots: [0, 1], playerSlots: [2, 3], slots: [slot(2)] }; } };
}

describe("common SoulFire automation", () => {
  it("performs the 3-second teleport checks silently, without releasing held input", async () => {
    const f = fixture({ crouch_enabled: true, auto_button: "right" });
    await f.engine.spawned(); await f.engine.tick();
    expect(f.game.sneak).toHaveBeenCalledTimes(1);
    f.advance(5000); f.engine.onChat(null, "Du hast die Teleportations-Anfrage von Steve angenommen!"); await f.engine.tick();
    vi.mocked(f.game.sneak).mockClear(); vi.mocked(f.game.held).mockClear();
    f.advance(2999); await f.engine.tick(); expect(f.game.sneak).not.toHaveBeenCalled();
    f.advance(1); await f.engine.tick(); expect(f.game.sneak).toHaveBeenCalledExactlyOnceWith();
    expect(f.game.held).not.toHaveBeenCalled(); expect(f.emit).not.toHaveBeenCalled();
    f.engine.transition(); f.advance(3000); await f.engine.tick();
    expect(f.game.sneak).toHaveBeenCalledTimes(2);
  });

  it("never logs failed sneak checks and retries without changing the button", async () => {
    const f = fixture({ crouch_enabled: true, auto_button: "left" });
    vi.mocked(f.game.sneak).mockRejectedValueOnce(new Error("offline"));
    await f.engine.spawned(); await f.engine.tick(); f.advance(1000); await f.engine.tick();
    expect(f.game.sneak).toHaveBeenCalledTimes(2); expect(f.emit).not.toHaveBeenCalled();
    expect(f.game.held).toHaveBeenCalledExactlyOnceWith({ crouch_enabled: true, auto_button: "left" });
  });

  it("keeps the selected input across reconnects and world transitions, changes it only on configuration", async () => {
    const f = fixture({ auto_button: "right", crouch_enabled: true });
    await f.engine.spawned(); f.engine.joining(); await f.engine.spawned(); f.engine.transition();
    await f.engine.configure({ auto_button: "left", crouch_enabled: true });
    expect(vi.mocked(f.game.held).mock.calls.map(([cfg]) => cfg.auto_button)).toEqual(["right", "right", "left"]);
  });

  it("does not sneak when disabled or accept spoofed teleport announcements", async () => {
    const f = fixture({ crouch_enabled: false }); await f.engine.spawned();
    f.engine.onChat("attacker", "Du wurdest zu deinem Home Test teleportiert!"); f.advance(3000); await f.engine.tick();
    expect(f.game.sneak).not.toHaveBeenCalled(); expect(f.emit).not.toHaveBeenCalled();
  });

  it("transfers only player slots from its own current sale menu and waits for acknowledgment", async () => {
    const f = fixture({ autosell_enabled: true, autosell_interval_seconds: 60 });
    await f.engine.spawned(); f.advance(2000); await f.engine.tick(); expect(f.game.chat).toHaveBeenCalledWith("/sell");
    f.sellMenu(); await f.engine.tick(); expect(f.game.click).toHaveBeenCalledExactlyOnceWith("sell-1", 2, "transfer");
    f.advance(100); await f.engine.tick(); expect(f.game.click).toHaveBeenCalledTimes(1); expect(f.game.close).not.toHaveBeenCalled();
    f.inventory({ slots: [] }); f.advance(100); await f.engine.tick(); expect(f.game.close).toHaveBeenCalledExactlyOnceWith("sell-1");
    const reads = vi.mocked(f.game.inventory).mock.calls.length;
    f.advance(100); await f.engine.tick(); expect(f.game.inventory).toHaveBeenCalledTimes(reads);
  });

  it("waits for content in a newly opened empty sale menu before closing it", async () => {
    const f = fixture({ autosell_enabled: true }); await f.engine.spawned(); f.advance(2000); await f.engine.tick();
    f.sellMenu(); f.inventory({ slots: [] }); await f.engine.tick();
    f.advance(400); await f.engine.tick(); expect(f.game.close).not.toHaveBeenCalled();
    f.inventory({ slots: [slot(2)] }); await f.engine.tick();
    expect(f.game.click).toHaveBeenCalledWith("sell-1", 2, "transfer");
  });

  it("waits for delayed menus and does not abandon ownership after half a second", async () => {
    const f = fixture({ autosell_enabled: true }); await f.engine.spawned(); f.advance(2000); await f.engine.tick();
    f.advance(1500); await f.engine.tick(); f.sellMenu(); await f.engine.tick();
    expect(f.game.click).toHaveBeenCalledExactlyOnceWith("sell-1", 2, "transfer");
  });

  it("recovers missing replies and rejected transfers with finite retry deadlines", async () => {
    const f = fixture({ autosell_enabled: true, autosell_interval_seconds: 60 }); await f.engine.spawned(); f.advance(2000); await f.engine.tick();
    f.advance(10_000); await f.engine.tick(); f.advance(1500); await f.engine.tick();
    expect(f.game.chat).toHaveBeenCalledTimes(2);
    f.sellMenu(); vi.mocked(f.game.click).mockRejectedValueOnce(new Error("menu changed")); await f.engine.tick();
    f.inventory({ menuId: "player", containerSlots: [] }); f.advance(1500); await f.engine.tick();
    expect(f.game.chat).toHaveBeenCalledTimes(3);
  });

  it("abandons stale sale menus after teleport, then resumes using the new menu identity", async () => {
    const f = fixture({ autosell_enabled: true }); await f.engine.spawned(); f.advance(2000); await f.engine.tick(); f.sellMenu(); await f.engine.tick();
    f.engine.transition(); f.inventory({ menuId: "player-new", containerSlots: [], slots: [] }); f.advance(2000); await f.engine.tick();
    f.sellMenu("sell-new"); await f.engine.tick();
    expect(f.game.click).toHaveBeenLastCalledWith("sell-new", 2, "transfer");
  });

  it("resumes after the exact restart pause, including a respawn inside that pause", async () => {
    const f = fixture({ autosell_enabled: true }); await f.engine.spawned();
    f.engine.pause(0, 120_000); f.advance(60_000); f.engine.joining(); await f.engine.spawned(); await f.engine.tick();
    f.advance(59_999); await f.engine.tick(); expect(f.game.chat).not.toHaveBeenCalled();
    f.advance(1); await f.engine.tick(); expect(f.game.chat).toHaveBeenCalledWith("/sell");
  });

  it("leaves foreign/manual menus alone and never clicks a replacement menu", async () => {
    const f = fixture({ autosell_enabled: true }); await f.engine.spawned(); f.advance(2000); await f.engine.tick();
    f.inventory({ menuId: "foreign", title: "Personal chest", containerSlots: [0, 1], slots: [slot(2)] });
    await f.engine.tick(); f.advance(60_000); await f.engine.tick();
    expect(f.game.click).not.toHaveBeenCalled(); expect(f.game.close).not.toHaveBeenCalled();
  });

  it("preempts automatic selling for manual commands and honors the command budget", async () => {
    const f = fixture({ autosell_enabled: true }); await f.engine.spawned(); f.advance(2000); await f.engine.tick(); f.sellMenu(); await f.engine.tick();
    f.engine.enqueue("chat", "/home base"); await f.engine.tick();
    expect(f.game.close).toHaveBeenCalledWith("sell-1"); expect(f.game.chat).toHaveBeenLastCalledWith("/home base");
    f.inventory({ containerSlots: [], menuId: "player" });
    f.engine.enqueue("chat", "/first"); f.engine.enqueue("chat", "/second"); await f.engine.tick(); await f.engine.tick();
    expect(f.game.chat).not.toHaveBeenCalledWith("/second"); f.advance(1500); await f.engine.tick(); expect(f.game.chat).toHaveBeenLastCalledWith("/second");
  });

  it("reads all nine /desmo categories and closes the matching menu", async () => {
    const f = fixture(); await f.engine.spawned(); f.advance(2000); f.engine.enqueue("read_sell_multipliers"); await f.engine.tick();
    expect(f.game.chat).toHaveBeenCalledWith("/sellmulti");
    f.inventory({ menuId: "multi", title: "SELL MULTI", containerSlots: Array.from({ length: 9 }, (_, i) => i), slots: Array.from({ length: 9 }, (_, i) => ({ ...slot(i), displayName: `Category ${i}`, tooltipLines: ["Aktueller Multiplikator: 2x", "Fortschritt: 50$/100$ - 50%"] })) });
    await f.engine.tick(); expect(f.game.close).toHaveBeenCalledWith("multi");
    expect(f.emit).toHaveBeenCalledWith({ type: "sell_multipliers", entries: expect.arrayContaining([expect.objectContaining({ multiplier: "2x", progress: "50$/100$ - 50%" })]) });
    expect(f.emit.mock.calls[0][0].entries).toHaveLength(9);
  });

  it("drops configured spawner stock, keeps one stack, then uses the sell button", async () => {
    const f = fixture({ crouch_enabled: true, spawner_type: "skeleton", spawner_drop_items: ["minecraft:bone"], spawner_sell_items: ["minecraft:arrow"] });
    await f.engine.spawned(); f.advance(2000); f.engine.enqueue("clean_spawner"); await f.engine.tick();
    expect(f.game.openSpawner).toHaveBeenCalledWith(true);
    const stock = [slot(0, "minecraft:bone"), slot(1, "minecraft:bone"), slot(2, "minecraft:arrow"), slot(3, "minecraft:arrow"), { ...slot(4, "minecraft:emerald"), displayName: "Verkaufen" }];
    f.inventory({ menuId: "spawner", title: "Spawner", containerSlots: [0, 1, 2, 3, 4], slots: stock }); f.advance(400); await f.engine.tick();
    expect(f.game.click).toHaveBeenLastCalledWith("spawner", 0, "drop");
    f.inventory({ slots: stock.slice(1) }); f.advance(400); await f.engine.tick(); await f.engine.tick();
    expect(f.game.click).toHaveBeenLastCalledWith("spawner", 4, "left");
    f.inventory({ slots: [stock[1], stock[2], stock[4]] }); f.advance(400); await f.engine.tick(); expect(f.game.close).toHaveBeenCalledWith("spawner");
  });
});
