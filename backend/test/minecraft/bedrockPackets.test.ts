import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotSender } from "../../src/bedrock-bot/send.js";
import { BehaviorState } from "../../src/bedrock-bot/behaviors.js";
import { BedrockInventory, type BedrockItem } from "../../src/bedrock-bot/inventory.js";
const require = createRequire(import.meta.url);
const { createSerializer } = require("bedrock-protocol/src/transforms/serializer");
const { Versions } = require("bedrock-protocol/src/options") as { Versions: Record<string, number> };

function inputFlag(params: any, flag: string): boolean {
  return Array.isArray(params.input_data) ? params.input_data.includes(flag) : params.input_data?.[flag] === true;
}

function setup(version = "1.21.130") {
  const serializer = createSerializer(version);
  const packets: Array<{ name: string; params: any }> = [];
  const queue = vi.fn((name: string, params: object) => {
    const bytes = serializer.createPacketBuffer({ name, params });
    packets.push(serializer.proto.parsePacketBuffer("mcpe_packet", bytes).data);
  });
  const sender = new BotSender({ queue, write: queue, versionGreaterThanOrEqualTo: v => Versions[version] >= Versions[v] }, "Bot");
  sender.setRuntimeEntityId(123n);
  sender.updatePosition({ x: 12, y: 70.62, z: -4 }, 20, 90);
  return { sender, packets, queue, inventory: new BedrockInventory(sender) };
}
const empty = (): BedrockItem => ({ network_id: 0 });
const stack = (stackId = 99, count = 64): BedrockItem => ({
  network_id: 1, count, metadata: 0, has_stack_id: 1, stack_id: stackId, block_runtime_id: 0,
  extra: { has_nbt: "false", can_place_on: [], can_destroy: [] },
});
function open(inventory: BedrockInventory, items = [stack()]) {
  inventory.onContent({ window_id: "inventory", input: Array.from({ length: 36 }, (_, i) => items[i] ?? empty()) });
  inventory.request(Date.now());
  inventory.onOpen({ window_id: "first", window_type: "container" });
  inventory.onContent({ window_id: "first", input: Array.from({ length: 27 }, empty) });
}
function ack(inventory: BedrockInventory, requestId: number, source: number, destination: number, count = 64) {
  inventory.onResponse({ responses: [{ status: "ok", request_id: requestId, containers: [
    { slot_type: { container_id: "hotbar_and_inventory" }, slots: [{ slot: source, count: 0, item_stack_id: 0 }] },
    { slot_type: { container_id: "container" }, slots: [{ slot: destination, count, item_stack_id: 100 + destination }] },
  ] }] });
}

describe("Bedrock automation with the installed wire codec", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(process.stdout, "write").mockImplementation(() => true); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each([false, true])("sends no game packets during a pending join with crouch=%s", crouch => {
    const { sender, packets, queue } = setup("1.26.51");
    const behavior = new BehaviorState({
      host: "localhost", port: 19132, auth_type: "offline", username: "Bot", cache_dir: "",
      crouch_enabled: crouch, autosell_enabled: true, autosell_interval_seconds: 1,
    }, sender);
    behavior.enqueueChat("/home");
    behavior.checkCrouch();
    // Even if early game data already supplied an entity id and position,
    // the automation must wait for spawn instead of interfering with login.
    for (let i = 0; i < 3600; i++) { vi.advanceTimersByTime(50); behavior.onTick(); }
    behavior.updateConfig({ crouch_enabled: !crouch, autosell_enabled: true });
    behavior.onTick();
    expect(queue).not.toHaveBeenCalled();
    behavior.markSpawned(); vi.advanceTimersByTime(300); behavior.onTick();
    expect(packets.map(packet => packet.name)).toEqual(["player_auth_input", "command_request"]);
  });

  it.each(["1.21.50", "1.21.130", "1.26.40", "1.26.51"])("holds and releases sneak using auth input in %s", version => {
    const { sender, packets } = setup(version);
    sender.setSneak(true);
    for (let i = 0; i < 4; i++) expect(sender.tickInput()).toBe(true);
    expect(packets).toHaveLength(4);
    for (const { params } of packets) {
      expect(inputFlag(params, "sneak_down")).toBe(true);
      expect(params.position.x).toBe(12);
      expect(params.move_vector).toEqual({ x: 0, z: 0 });
    }
    expect(inputFlag(packets[0].params, "start_sneaking")).toBe(true);
    expect(inputFlag(packets[1].params, "start_sneaking")).toBe(false);
    sender.updatePosition({ x: 100, y: 65.62, z: 30 }, 0, 0, true);
    sender.setSneak(true); sender.tickInput();
    expect(inputFlag(packets.at(-1)!.params, "handled_teleport")).toBe(true);
    expect(inputFlag(packets.at(-1)!.params, "start_sneaking")).toBe(true);
    sender.setSneak(false); sender.tickInput();
    expect(inputFlag(packets.at(-1)!.params, "stop_sneaking")).toBe(true);
    expect(inputFlag(packets.at(-1)!.params, "sneak_down")).toBe(false);
    expect(packets.at(-1)!.params.tick).toBe(6n);
  });

  it.each(["1.21.50", "1.21.130", "1.26.40", "1.26.51"])("resynchronizes Geyser's cached shift across distinct input ticks in %s", version => {
    const { sender, packets, queue } = setup(version);
    sender.setSneak(true); sender.tickInput();
    sender.setSneak(true, true);
    queue.mockImplementationOnce(() => { throw new Error("temporary failure"); });
    expect(sender.tickInput()).toBe(false);
    expect(sender.tickInput()).toBe(true);
    expect(inputFlag(packets.at(-1)!.params, "stop_sneaking")).toBe(true);
    // A metadata reply to the release must not keep restarting the release.
    sender.setSneak(true, true); sender.tickInput();
    expect(inputFlag(packets.at(-1)!.params, "start_sneaking")).toBe(true);
    expect(inputFlag(packets.at(-1)!.params, "sneak_current_raw")).toBe(true);
    const downstream: boolean[] = [];
    let cached = false;
    for (const { params } of packets) {
      const next = inputFlag(params, "stop_sneaking") ? false : inputFlag(params, "start_sneaking") ? true : cached;
      if (next !== cached) downstream.push(next);
      cached = next;
    }
    expect(downstream).toEqual([true, false, true]);
    expect(packets[2].params.tick).toBeGreaterThan(packets[1].params.tick);
    sender.setSneak(true, true); sender.tickInput();
    sender.setSneak(false); sender.tickInput(); sender.tickInput();
    expect(packets.slice(-2).every(packet => !inputFlag(packet.params, "sneak_down"))).toBe(true);
  });

  it.each(["1.26.40", "1.26.51"])("encodes modern %s crouch as a list of active flags", version => {
    const { sender, packets } = setup(version);
    sender.setSneak(true); sender.tickInput();
    expect(packets[0].params.input_data).toEqual(expect.arrayContaining(["sneaking", "sneak_down", "start_sneaking", "sneak_current_raw"]));
    expect(packets[0].params.input_data).not.toContain("stop_sneaking");
    sender.setSneak(false); sender.tickInput();
    expect(packets[1].params.input_data).toEqual(expect.arrayContaining(["stop_sneaking", "sneak_released_raw"]));
    expect(packets[1].params.input_data).not.toContain("sneak_down");
  });

  it("uses only decoded server flags for the local player's crouch confirmation", () => {
    const { sender, queue, packets } = setup();
    for (const [runtime_entity_id, sneaking, expected] of [[999n, true, null], [123n, false, false], [123n, true, true]] as const) {
      queue("set_entity_data", { runtime_entity_id, metadata: [{ key: "flags", type: "long", value: { sneaking } }], properties: { ints: [], floats: [] }, tick: 1n });
      expect(sender.observeSneakMetadata(packets.at(-1)!.params)).toBe(expected);
    }
    expect(sender.observeSneakMetadata({ runtime_entity_id: 123n, metadata: [{ key: "nametag", value: "Bot" }] })).toBeNull();
    expect(sender.observeSneakMetadata({ runtime_entity_id: "invalid", metadata: [] })).toBeNull();
  });

  it("releases and reasserts crouch after negative server feedback without getting stuck in release", () => {
    const { sender, packets } = setup();
    const behavior = new BehaviorState({ host: "localhost", port: 19132, auth_type: "offline", username: "Bot", cache_dir: "", crouch_enabled: true }, sender);
    behavior.markSpawned(); vi.advanceTimersByTime(300); behavior.onTick();
    behavior.onSneakStatus(true); vi.advanceTimersByTime(2100);
    behavior.onSneakStatus(false); behavior.onTick();
    expect(inputFlag(packets.at(-1)!.params, "stop_sneaking")).toBe(true);
    behavior.onSneakStatus(false); vi.advanceTimersByTime(50); behavior.onTick();
    expect(inputFlag(packets.at(-1)!.params, "start_sneaking")).toBe(true);
    // Delayed metadata from our deliberate release arrives after the press.
    vi.advanceTimersByTime(300); behavior.onSneakStatus(false); behavior.onTick();
    expect(inputFlag(packets.at(-1)!.params, "sneak_down")).toBe(true);
    expect(inputFlag(packets.at(-1)!.params, "stop_sneaking")).toBe(false);
    behavior.onSneakStatus(true); vi.advanceTimersByTime(2100); behavior.onTick();
    expect(inputFlag(packets.at(-1)!.params, "sneak_down")).toBe(true);
    expect(inputFlag(packets.at(-1)!.params, "stop_sneaking")).toBe(false);
    behavior.markTeleported(); vi.advanceTimersByTime(150); behavior.onTick();
    expect(inputFlag(packets.at(-1)!.params, "stop_sneaking")).toBe(true);
    vi.advanceTimersByTime(50); behavior.onTick();
    expect(inputFlag(packets.at(-1)!.params, "start_sneaking")).toBe(true);
  });

  it("retries input after a transient serialization failure", () => {
    const { sender, packets, queue } = setup();
    sender.setSneak(true);
    queue.mockImplementationOnce(() => { throw new Error("not ready"); });
    expect(sender.tickInput()).toBe(false);
    expect(sender.tickInput()).toBe(true);
    expect(inputFlag(packets[0].params, "start_sneaking")).toBe(true);
  });

  it.each(["1.21.50", "1.21.130", "1.26.40", "1.26.51"])("transfers actual stacks and closes only after matching acknowledgements in %s", version => {
    const { inventory, packets } = setup(version);
    open(inventory, [stack(99), stack(101, 32)]);
    inventory.tick(Date.now());
    const request = packets[0].params.requests[0];
    expect(request.actions[0]).toMatchObject({ type_id: "place", count: 64,
      source: { slot_type: { container_id: "hotbar_and_inventory" }, slot: 0, stack_id: 99 }, destination: { slot_type: { container_id: "container" }, slot: 0, stack_id: 0 } });
    inventory.onResponse({ responses: [{ request_id: -999, status: "ok" }] });
    inventory.tick(Date.now()); expect(packets).toHaveLength(1);
    ack(inventory, request.request_id, 0, 0);
    inventory.tick(Date.now());
    expect(packets[1].params.requests[0].actions[0].destination.slot).toBe(1);
    ack(inventory, packets[1].params.requests[0].request_id, 1, 1, 32);
    inventory.tick(Date.now());
    expect(packets[2].name).toBe("container_close");
    expect(inventory.busy).toBe(false);
  });

  it("uses legacy inventory transactions only when the server advertises them", () => {
    const { inventory, sender, packets } = setup(); sender.authoritativeInventory = false;
    open(inventory); inventory.tick(Date.now());
    expect(packets[0].name).toBe("inventory_transaction");
    expect(packets[0].params.transaction.actions[0]).toMatchObject({ old_item: { count: 64 }, new_item: { network_id: 0 } });
    inventory.onSlot({ window_id: "inventory", slot: 0, item: empty() });
    inventory.tick(Date.now()); expect(packets).toHaveLength(1);
    inventory.onSlot({ window_id: "first", slot: 0, item: stack(100) });
    inventory.tick(Date.now()); expect(packets.at(-1)!.name).toBe("container_close");
  });

  it("keeps the join deadline bounded despite continuous pickups and retries selling", () => {
    const { sender, packets } = setup();
    const behavior = new BehaviorState({ host: "localhost", port: 19132, auth_type: "offline", username: "Bot", cache_dir: "", autosell_enabled: true, autosell_interval_seconds: 5 }, sender);
    behavior.markSpawned(); vi.advanceTimersByTime(300); behavior.onTick();
    for (let i = 0; i < 120; i++) {
      behavior.inventory.onSlot({ window_id: "inventory", slot: i % 36, item: stack(1000 + i) });
      vi.advanceTimersByTime(50); behavior.onTick();
    }
    expect(packets.filter(p => p.name === "command_request")).toHaveLength(2);
    behavior.inventory.onOpen({ window_id: "first", window_type: "container" });
    behavior.inventory.onContent({ window_id: "first", input: Array.from({ length: 27 }, empty) });
    behavior.onTick();
    expect(packets.some(p => p.name === "item_stack_request")).toBe(true);
  });

  it("leaves foreign menus untouched and lets manual commands interrupt unacknowledged sells", () => {
    const { sender, inventory, packets } = setup();
    inventory.onOpen({ window_id: "first", window_type: "container" }); inventory.tick(Date.now());
    expect(packets).toHaveLength(0); expect(inventory.blocked).toBe(true);
    const behavior = new BehaviorState({ host: "localhost", port: 19132, auth_type: "offline", username: "Bot", cache_dir: "", autosell_enabled: true }, sender);
    behavior.markSpawned(); open(behavior.inventory); behavior.inventory.tick(Date.now());
    behavior.enqueueChat("/home farm"); behavior.onTick();
    expect(packets.slice(-2).map(p => p.name)).toEqual(["container_close", "command_request"]);
    expect(packets.at(-1)!.params.command).toBe("/home farm");
  });

  it("closes delayed sell replies after a manual command and preserves the homes menu", () => {
    const { sender, packets } = setup();
    const behavior = new BehaviorState({ host: "localhost", port: 19132, auth_type: "offline", username: "Bot", cache_dir: "", autosell_enabled: true, autosell_interval_seconds: 0.25 }, sender);
    behavior.markSpawned(); vi.advanceTimersByTime(300); behavior.onTick();
    behavior.enqueueChat("/homes"); behavior.onTick();
    const position = { x: 10, y: 70, z: 20 };
    behavior.inventory.onOpen({ window_id: "first", window_type: "container", coordinates: position });
    behavior.inventory.onBlockEntity({ coordinates: position, nbt: { value: { CustomName: { value: "Items verkaufen" } } } });
    expect(packets.at(-1)!.name).toBe("container_close");
    expect(behavior.inventory.blocked).toBe(false);
    behavior.inventory.onBlockEntity({ coordinates: position, nbt: { value: { CustomName: { value: "Homes" } } } });
    behavior.inventory.onOpen({ window_id: "first", window_type: "container", coordinates: position });
    const before = packets.filter(p => p.name === "container_close" || p.name === "item_stack_request" || p.name === "command_request").length;
    vi.advanceTimersByTime(5100); behavior.onTick();
    expect(behavior.inventory.blocked).toBe(true);
    expect(packets.filter(p => p.name === "container_close" || p.name === "item_stack_request" || p.name === "command_request")).toHaveLength(before);
    // Explicit /sell remains manual even inside the late-response guard.
    behavior.enqueueChat("/sell"); behavior.onTick();
    behavior.inventory.onBlockEntity({ coordinates: position, nbt: { value: { CustomName: { value: "Items verkaufen" } } } });
    behavior.inventory.onOpen({ window_id: "first", window_type: "container", coordinates: position });
    expect(packets.at(-1)!.name).toBe("command_request");
    expect(behavior.inventory.blocked).toBe(true);
  });

  it("accepts fresh sell replies again after the manual command pause", () => {
    const { sender, packets } = setup();
    const behavior = new BehaviorState({ host: "localhost", port: 19132, auth_type: "offline", username: "Bot", cache_dir: "", autosell_enabled: true, autosell_interval_seconds: 0.25 }, sender);
    behavior.markSpawned(); vi.advanceTimersByTime(300); behavior.onTick();
    behavior.enqueueChat("/tpa Steve"); behavior.onTick();
    vi.advanceTimersByTime(5000); behavior.onTick();
    expect(packets.filter(p => p.name === "command_request").map(p => p.params.command)).toEqual(["/sell", "/tpa Steve", "/sell"]);
    const position = { x: 10, y: 70, z: 20 };
    behavior.inventory.onBlockEntity({ coordinates: position, nbt: { value: { CustomName: { value: "Items verkaufen" } } } });
    behavior.inventory.onOpen({ window_id: "first", window_type: "container", coordinates: position });
    behavior.inventory.onContent({ window_id: "inventory", input: Array.from({ length: 36 }, (_, i) => i === 0 ? stack() : empty()) });
    behavior.inventory.onContent({ window_id: "first", input: Array.from({ length: 27 }, empty) });
    behavior.onTick();
    expect(packets.at(-1)!.name).toBe("item_stack_request");
  });

  it("recovers a named startup sell menu even when its title arrives after opening", () => {
    const { inventory, packets } = setup();
    inventory.onContent({ window_id: "inventory", input: Array.from({ length: 36 }, (_, i) => i === 0 ? stack() : empty()) });
    inventory.onOpen({ window_id: "first", window_type: "container", coordinates: { x: 10, y: 70, z: 20 } });
    inventory.onContent({ window_id: "first", input: Array.from({ length: 27 }, empty) });
    inventory.onBlockEntity({ coordinates: { x: 10, y: 70, z: 20 }, nbt: { value: { CustomName: { value: "§aItems verkaufen" } } } });
    inventory.tick(Date.now());
    expect(packets[0].name).toBe("item_stack_request");
  });

  it("does not take over a manually opened named sell GUI", () => {
    const { inventory, packets } = setup(); inventory.interrupt(true);
    const coordinates = { x: 10, y: 70, z: 20 };
    inventory.onBlockEntity({ coordinates, nbt: { value: { CustomName: { value: "Items verkaufen" } } } });
    inventory.onOpen({ window_id: "first", window_type: "container", coordinates });
    vi.advanceTimersByTime(10_000); inventory.tick(Date.now());
    expect(inventory.blocked).toBe(true); expect(packets).toHaveLength(0);
  });

  it("times out rejected or unconfirmed transfers without repeating a stale click", () => {
    const { inventory, packets } = setup(); open(inventory); inventory.tick(Date.now());
    vi.advanceTimersByTime(2000); inventory.tick(Date.now());
    expect(packets.map(p => p.name)).toEqual(["item_stack_request", "container_close"]);
    expect(inventory.busy).toBe(false);
    open(inventory); inventory.tick(Date.now());
    inventory.onResponse({ responses: [{ request_id: packets.at(-1)!.params.requests[0].request_id, status: "error" }] });
    inventory.tick(Date.now());
    expect(inventory.busy).toBe(false);
  });

  it("continues selling other stacks when a tool/non-sellable slot is rejected", () => {
    const { inventory, packets } = setup(); open(inventory, [stack(99), stack(101)]);
    inventory.tick(Date.now());
    inventory.onResponse({ responses: [{ request_id: -1, status: "error" }] });
    inventory.tick(Date.now());
    expect(packets[1].params.requests[0].actions[0].source.slot).toBe(1);
    ack(inventory, -2, 1, 0); inventory.tick(Date.now());
    expect(packets.at(-1)!.name).toBe("container_close");
  });

  it("checks held sneak for both supplied teleport success messages and again later", () => {
    const { sender, packets } = setup();
    const behavior = new BehaviorState({ host: "localhost", port: 19132, auth_type: "offline", username: "Bot", cache_dir: "", crouch_enabled: true }, sender);
    behavior.markSpawned(); vi.advanceTimersByTime(300); behavior.onTick();
    for (const message of ["<HugoSMP> Du wurdest zu deinem Home Farm teleportiert!", "[HugoSMP] Steve hat deine Teleportations-Anfrage angenommen!"]) {
      behavior.onChat(null, message); behavior.onTick();
      expect(inputFlag(packets.at(-1)!.params, "stop_sneaking")).toBe(true);
      vi.advanceTimersByTime(50); behavior.onTick();
      expect(inputFlag(packets.at(-1)!.params, "start_sneaking")).toBe(true);
      vi.advanceTimersByTime(2100); behavior.onTick();
      expect(inputFlag(packets.at(-1)!.params, "start_sneaking")).toBe(true);
    }
  });
});
