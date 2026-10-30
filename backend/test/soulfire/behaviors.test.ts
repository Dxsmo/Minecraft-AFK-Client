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
  it("sends all 36 stacks in one native action and keeps the requested interval despite immediate refills", async () => {
    const f = fixture({ autosell_enabled: true, autosell_interval_seconds: 2 });
    f.game.transferAll = vi.fn(async () => {});
    await f.engine.spawned(); f.advance(2000); await f.engine.tick(); f.sellMenu();
    f.inventory({ playerSlots: Array.from({ length: 36 }, (_, i) => i + 27), slots: Array.from({ length: 36 }, (_, i) => slot(i + 27)) });
    await f.engine.tick();
    expect(f.game.transferAll).toHaveBeenCalledExactlyOnceWith("sell-1"); expect(f.game.click).not.toHaveBeenCalled();
    f.engine.onChat(null, "[HugoSMP] +$121,60 (Basis: $64, Bonus: +$57,60 durch 1.9x)");
    await f.engine.tick(); expect(f.game.close).toHaveBeenCalledExactlyOnceWith("sell-1");
    f.inventory({ menuId: "player", containerSlots: [] });
    f.advance(1999); await f.engine.tick(); expect(f.game.chat).toHaveBeenCalledTimes(1);
    f.advance(1); await f.engine.tick(); expect(f.game.chat).toHaveBeenCalledTimes(2);
  });
  it("keeps the confirmation deadline for a native batch with no inventory change or genuine payout", async () => {
    const f = fixture({ autosell_enabled: true }); f.game.transferAll = vi.fn(async () => {});
    await f.engine.spawned(); f.advance(2000); await f.engine.tick(); f.sellMenu(); await f.engine.tick();
    f.advance(4999); await f.engine.tick(); expect(f.game.close).not.toHaveBeenCalled();
    f.advance(1); await f.engine.tick();
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Item-Transfer wurde nicht bestätigt") }));
    expect(f.game.transferAll).toHaveBeenCalledTimes(1);
  });
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

  it.each([0.25, 0.5, 1, 2])("keeps a %ss sell interval across repeated cycles without a 1.5s command floor", async interval => {
    const f = fixture({ autosell_enabled: true, autosell_interval_seconds: interval });
    let cycle = 0;
    vi.mocked(f.game.chat).mockImplementation(async () => { f.sellMenu(`sale-${++cycle}`); });
    vi.mocked(f.game.click).mockImplementation(async () => { f.inventory({ slots: [] }); });
    vi.mocked(f.game.close).mockImplementation(async () => { f.inventory({ menuId: "player", containerSlots: [], slots: [] }); });
    await f.engine.spawned(); f.advance(2000);
    for (let i = 0; i < 12; i++) {
      if (i) { f.advance(interval * 1000 - 1); await f.engine.tick(); expect(f.game.chat).toHaveBeenCalledTimes(i); f.advance(1); }
      for (let tick = 0; tick < 4; tick++) await f.engine.tick();
      expect(f.game.chat).toHaveBeenCalledTimes(i + 1);
    }
    expect(f.game.click).toHaveBeenCalledTimes(12); expect(f.emit).not.toHaveBeenCalled();
  });

  it("measures the next sale from dispatch instead of adding the command RPC latency", async () => {
    const f = fixture({ autosell_enabled: true, autosell_interval_seconds: 2 });
    vi.mocked(f.game.chat).mockImplementation(async () => { f.advance(500); f.sellMenu(); });
    vi.mocked(f.game.click).mockImplementation(async () => { f.inventory({ slots: [] }); });
    vi.mocked(f.game.close).mockImplementation(async () => { f.inventory({ menuId: "player", containerSlots: [], slots: [] }); });
    await f.engine.spawned(); f.advance(2000);
    for (let i = 0; i < 4; i++) await f.engine.tick();
    f.advance(1499); await f.engine.tick(); expect(f.game.chat).toHaveBeenCalledTimes(1);
    f.advance(1); await f.engine.tick(); expect(f.game.chat).toHaveBeenCalledTimes(2);
  });

  it("retries a failed sale without adding a 1.5s cooldown", async () => {
    const f = fixture({ autosell_enabled: true, autosell_interval_seconds: 0.25 });
    await f.engine.spawned(); f.advance(2000); await f.engine.tick();
    f.advance(10000); await f.engine.tick(); await f.engine.tick();
    expect(f.game.chat).toHaveBeenCalledTimes(2);
  });

  it("pauses automation during remote control and resumes the configured input afterwards", async () => {
    const f = fixture({ autosell_enabled: true, autosell_interval_seconds: 2, crouch_enabled: true, auto_button: "right" });
    await f.engine.spawned(); f.advance(2000); await f.engine.tick(); f.sellMenu(); await f.engine.tick();
    await f.engine.remote(true);
    vi.mocked(f.game.chat).mockClear(); vi.mocked(f.game.click).mockClear(); vi.mocked(f.game.sneak).mockClear();
    f.advance(30000); await f.engine.tick();
    expect(f.game.chat).not.toHaveBeenCalled(); expect(f.game.click).not.toHaveBeenCalled(); expect(f.game.sneak).not.toHaveBeenCalled();
    f.inventory({ menuId: "player", containerSlots: [], slots: [] });
    await f.engine.remote(false); await f.engine.tick();
    expect(f.game.chat).toHaveBeenCalledExactlyOnceWith("/sell");
    expect(f.game.held).toHaveBeenLastCalledWith(expect.objectContaining({ auto_button: "right", crouch_enabled: true }));
  });

  it("waits for content in a newly opened empty sale menu before closing it", async () => {
    const f = fixture({ autosell_enabled: true }); await f.engine.spawned(); f.advance(2000); await f.engine.tick();
    f.sellMenu(); f.inventory({ slots: [] }); await f.engine.tick();
    f.advance(400); await f.engine.tick(); expect(f.game.close).not.toHaveBeenCalled();
    f.inventory({ slots: [slot(2)] }); await f.engine.tick();
    expect(f.game.click).toHaveBeenCalledWith("sell-1", 2, "transfer");
  });

  it("accepts a server payout when hoppers refill the transferred slot to the same count", async () => {
    const f = fixture({ autosell_enabled: true }); await f.engine.spawned(); f.advance(2000); await f.engine.tick();
    f.sellMenu(); f.inventory({ slots: [slot(2), slot(3)] }); await f.engine.tick();
    f.engine.onChat(null, "[HugoSMP] +$121,60 (Basis: $64, Bonus: +$57,60 durch 1.9x)");
    f.advance(100); await f.engine.tick();
    expect(f.game.click).toHaveBeenLastCalledWith("sell-1", 3, "transfer");
    expect(f.emit).not.toHaveBeenCalled();
  });

  it("ignores player payout imitations and retains a finite deadline for a genuinely stalled transfer", async () => {
    const f = fixture({ autosell_enabled: true }); await f.engine.spawned(); f.advance(2000); await f.engine.tick(); f.sellMenu(); await f.engine.tick();
    f.engine.onChat("attacker", "[HugoSMP] +$121,60 (Basis: $64, Bonus: +$57,60 durch 1.9x)");
    f.engine.onChat(null, "<attacker> [HugoSMP] +$121,60 (Basis: $64, Bonus: +$57,60 durch 1.9x)");
    f.advance(5000); await f.engine.tick();
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Item-Transfer wurde nicht bestätigt") }));
    expect(f.game.click).toHaveBeenCalledTimes(1);
  });

  it("does not apply the menu-opening deadline to a sale that is still making progress", async () => {
    const f = fixture({ autosell_enabled: true }); await f.engine.spawned(); f.advance(2000); await f.engine.tick(); f.sellMenu();
    f.inventory({ playerSlots: [2, 3, 4, 5], slots: [slot(2), slot(3), slot(4), slot(5)] });
    await f.engine.tick();
    for (let i = 2; i <= 5; i++) {
      f.inventory({ slots: Array.from({ length: 5 - i }, (_, n) => slot(i + n + 1)) });
      f.advance(4000); await f.engine.tick();
    }
    expect(f.game.click).toHaveBeenCalledTimes(4);
    expect(f.game.close).toHaveBeenCalledExactlyOnceWith("sell-1"); expect(f.emit).not.toHaveBeenCalled();
  });

  it("starts the acknowledgment budget after the RPC and preserves payouts received during the click", async () => {
    const f = fixture({ autosell_enabled: true }); await f.engine.spawned(); f.advance(2000); await f.engine.tick(); f.sellMenu();
    vi.mocked(f.game.click).mockImplementationOnce(async () => {
      f.advance(8000);
      f.engine.onChat("HugoSMP", "+$121,60 (Basis: $64, Bonus: +$57,60 durch 1.9x)");
    });
    await f.engine.tick(); f.advance(100); await f.engine.tick();
    expect(f.game.close).toHaveBeenCalledExactlyOnceWith("sell-1"); expect(f.emit).not.toHaveBeenCalled();
  });

  it("waits for a delayed transfer acknowledgment after a slow click rather than immediately timing out", async () => {
    const f = fixture({ autosell_enabled: true }); await f.engine.spawned(); f.advance(2000); await f.engine.tick(); f.sellMenu();
    vi.mocked(f.game.click).mockImplementationOnce(async () => { f.advance(8000); });
    await f.engine.tick(); f.advance(100); await f.engine.tick();
    expect(f.game.close).not.toHaveBeenCalled(); expect(f.emit).not.toHaveBeenCalled();
    f.inventory({ slots: [] }); f.advance(100); await f.engine.tick();
    expect(f.game.close).toHaveBeenCalledExactlyOnceWith("sell-1");
  });

  it("does not revive an old sale if a teleport happens while its command is being sent", async () => {
    const f = fixture({ autosell_enabled: true }); await f.engine.spawned(); f.advance(2000);
    vi.mocked(f.game.chat).mockImplementationOnce(async () => { f.engine.transition(); });
    await f.engine.tick(); f.sellMenu(); f.advance(100); await f.engine.tick();
    expect(f.game.click).not.toHaveBeenCalled(); expect(f.game.close).not.toHaveBeenCalled();
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

  it("preempts automatic selling and keeps the separate manual command budget", async () => {
    const f = fixture({ autosell_enabled: true }); await f.engine.spawned(); f.advance(2000); await f.engine.tick(); f.sellMenu(); await f.engine.tick();
    f.engine.enqueue("chat", "/home base"); await f.engine.tick();
    expect(f.game.close).toHaveBeenCalledWith("sell-1"); expect(f.game.chat).toHaveBeenLastCalledWith("/home base");
    f.inventory({ containerSlots: [], menuId: "player" });
    f.engine.enqueue("chat", "/first"); f.engine.enqueue("chat", "/second"); f.engine.enqueue("chat", "/third");
    await f.engine.tick(); await f.engine.tick(); await f.engine.tick();
    expect(f.game.chat).toHaveBeenCalledWith("/second"); expect(f.game.chat).not.toHaveBeenCalledWith("/third");
    f.advance(1500); await f.engine.tick(); expect(f.game.chat).toHaveBeenLastCalledWith("/third");
  });

  it("closes the active sale menu only once before dispatching a manual command", async () => {
    const f = fixture({ autosell_enabled: true }); await f.engine.spawned(); f.advance(2000); await f.engine.tick(); f.sellMenu(); await f.engine.tick();
    f.engine.enqueue("chat", "/homes"); await f.engine.tick();
    expect(f.game.close).toHaveBeenCalledExactlyOnceWith("sell-1");
    expect(f.game.chat).toHaveBeenLastCalledWith("/homes");
  });

  it("identifies a failed manual command without silently repeating an ambiguous send", async () => {
    const f = fixture(); await f.engine.spawned();
    vi.mocked(f.game.chat).mockRejectedValueOnce(new Error("deadline_exceeded"));
    f.engine.enqueue("chat", "/home base"); await f.engine.tick(); await f.engine.tick();
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Befehl /home base fehlgeschlagen") }));
    expect(f.game.chat).toHaveBeenCalledTimes(1);
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

  it("retains one stack of every configured drop item instead of one stack in total", async () => {
    const f = fixture({ spawner_type: "cow", spawner_drop_items: ["minecraft:beef", "minecraft:leather"] });
    await f.engine.spawned(); f.advance(2000); f.engine.enqueue("clean_spawner"); await f.engine.tick();
    const stock = [slot(0, "minecraft:beef"), slot(1, "minecraft:beef"), slot(2, "minecraft:leather"), slot(3, "minecraft:leather"), slot(4, "minecraft:diamond")];
    f.inventory({ menuId: "spawner", containerSlots: [0, 1, 2, 3, 4], slots: stock });
    f.advance(400); await f.engine.tick(); expect(f.game.click).toHaveBeenLastCalledWith("spawner", 0, "drop");
    f.inventory({ slots: stock.slice(1) }); f.advance(400); await f.engine.tick();
    expect(f.game.click).toHaveBeenLastCalledWith("spawner", 2, "drop");
    f.inventory({ slots: [stock[1], stock[3], stock[4]] }); f.advance(400); await f.engine.tick(); await f.engine.tick();
    expect(f.game.click).toHaveBeenCalledTimes(2); expect(f.game.close).toHaveBeenCalledExactlyOnceWith("spawner");
  });

  it("waits for a real spawner change instead of repeating drops or falsely announcing success", async () => {
    const f = fixture({ spawner_type: "cow", spawner_drop_items: ["minecraft:beef"] });
    await f.engine.spawned(); f.advance(2000); f.engine.enqueue("clean_spawner"); await f.engine.tick();
    f.inventory({ menuId: "spawner", containerSlots: [0, 1], slots: [slot(0, "minecraft:beef"), slot(1, "minecraft:beef")] });
    f.advance(400); await f.engine.tick();
    for (let i = 0; i < 10; i++) { f.advance(400); await f.engine.tick(); }
    expect(f.game.click).toHaveBeenCalledTimes(1); expect(f.game.close).not.toHaveBeenCalled();
    f.advance(1000); await f.engine.tick();
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({ type: "warning", message: "CleanSpawner: Änderung wurde nicht bestätigt; Vorgang abgebrochen" });
    expect(f.game.close).toHaveBeenCalledExactlyOnceWith("spawner");
  });

  it("does not bind a foreground action to the menu it just closed", async () => {
    const f = fixture({ spawner_type: "cow", spawner_drop_items: ["minecraft:beef"] }); await f.engine.spawned();
    f.advance(2000);
    f.inventory({ menuId: "old", containerSlots: [0, 1], slots: [slot(0, "minecraft:beef"), slot(1, "minecraft:beef")] });
    f.engine.enqueue("clean_spawner"); await f.engine.tick(); f.advance(500); await f.engine.tick();
    expect(f.game.click).not.toHaveBeenCalled();
    f.inventory({ menuId: "new" }); await f.engine.tick(); expect(f.game.click).toHaveBeenCalledExactlyOnceWith("new", 0, "drop");
  });

  it("does not restore a spawner job after a world transition during the interaction RPC", async () => {
    const f = fixture({ spawner_type: "cow", spawner_drop_items: ["minecraft:beef"] }); await f.engine.spawned();
    vi.mocked(f.game.openSpawner).mockImplementationOnce(async () => { f.engine.transition(); return true; });
    f.engine.enqueue("clean_spawner"); await f.engine.tick();
    f.inventory({ menuId: "foreign", containerSlots: [0, 1], slots: [slot(0, "minecraft:beef"), slot(1, "minecraft:beef")] });
    f.advance(2500); await f.engine.tick(); expect(f.game.click).not.toHaveBeenCalled();
  });
});
