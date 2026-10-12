import { createRequire } from "node:module";
import { createCipheriv, createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BedrockPacketRecovery, installBedrockFrameValidation, splitBedrockFrames } from "../../src/bedrock-bot/packetRecovery.js";
import { BotSender } from "../../src/bedrock-bot/send.js";
import { BehaviorState } from "../../src/bedrock-bot/behaviors.js";

const require = createRequire(import.meta.url);
const { createDeserializer, createSerializer } = require("bedrock-protocol/src/transforms/serializer");
const { Client } = require("bedrock-protocol/src/client");
const { ClientStatus, Connection } = require("bedrock-protocol/src/connection");
const { Versions } = require("bedrock-protocol/src/options");
const { Framer } = require("bedrock-protocol/src/transforms/framer");
const originalSplit = Framer.getPackets;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  Framer.getPackets = originalSplit;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(version: string, spawned = true) {
  const serializer = createSerializer(version);
  const deserializer = createDeserializer(version);
  const sent: Array<{ name: string; params: any }> = [];
  const sentWire: Buffer[] = [];
  const queue = vi.fn((name: string, params: object) => {
    const bytes = serializer.createPacketBuffer({ name, params });
    sentWire.push(bytes);
    sent.push(serializer.proto.parsePacketBuffer("mcpe_packet", bytes).data);
  });
  // delayedInit creates the real library client without authentication or sockets.
  const client = Object.assign(new Client({ version, delayedInit: true, offline: true, conLog: null }), {
    options: { version, protocolVersion: Versions[version] }, deserializer, serializer, queue,
    status: ClientStatus.Initialized,
    features: { compressorInHeader: true }, compressionReady: true,
    compressionAlgorithm: "deflate", compressionThreshold: 0,
    batchHeader: 0xfe, close: vi.fn(),
  });
  const sender = new BotSender(client, "Bot");
  const behavior = new BehaviorState({ host: "localhost", port: 19132, username: "Bot", auth_type: "offline", cache_dir: "" }, sender);
  const inventory = behavior.inventory;
  const warnings: string[] = [];
  const errors: Error[] = [];
  const recovery = new BedrockPacketRecovery(client, inventory, () => spawned, message => warnings.push(message));
  client.on("error", error => {
    if (!recovery.recover(error)) { errors.push(error); client.close(); }
  });
  // The library's createClient uses this reply for proxy responsiveness.
  client.on("network_stack_latency", packet => {
    if (packet.needs_response) queue("network_stack_latency", { timestamp: packet.timestamp, needs_response: false });
  });
  client.on("inventory_content", packet => inventory.onContent(packet));
  client.on("inventory_slot", packet => inventory.onSlot(packet));
  client.on("block_entity_data", packet => inventory.onBlockEntity(packet));
  return { client, inventory, serializer, warnings, errors, sent, sentWire, recovery, behavior };
}

// Independent fixture: block entity at (0, 64, 0), unnamed network-NBT
// compound, followed by the invalid child type 115 from the user's log.
const invalidBlockNbt = Buffer.from([0x38, 0x00, 0x40, 0x00, 0x0a, 0x00, 0x73, 0x00]);

it.each(["1.21.50", "1.21.130", "1.26.40", "1.26.51"].flatMap(version => [false, true].map(encrypted => [version, encrypted] as const)))("keeps reading and replies after Invalid tag 115 in %s with encryption=%s", (version, encrypted) => {
  const { client, serializer, warnings, errors, sentWire } = setup(version);
  const badPacketHandler = vi.fn();
  client.on("block_entity_data", badPacketHandler);
  const health: number[] = [];
  client.on("set_health", packet => health.push(packet.health));
  const batch = new Framer(client);
  batch.addEncodedPackets([
    invalidBlockNbt,
    serializer.createPacketBuffer({ name: "network_stack_latency", params: { timestamp: 123n, needs_response: true } }),
    serializer.createPacketBuffer({ name: "set_health", params: { health: 19 } }),
  ]);
  installBedrockFrameValidation();
  if (encrypted) {
    const key = Buffer.alloc(32, 7);
    const iv = Buffer.alloc(16, 9);
    client.secretKeyBytes = key;
    client.startEncryption(iv);
    const cipher = createCipheriv("aes-256-gcm", key, iv.subarray(0, 12));
    let counter = 0n;
    const send = (plaintext: Buffer) => {
      const compressed = Buffer.concat([Buffer.from([0]), deflateRawSync(plaintext)]);
      const encodedCounter = Buffer.alloc(8); encodedCounter.writeBigInt64LE(counter++);
      const checksum = createHash("sha256").update(encodedCounter).update(compressed).update(key).digest().subarray(0, 8);
      client.handle(Buffer.concat([Buffer.from([0xfe]), cipher.update(Buffer.concat([compressed, checksum]))]));
    };
    send(batch.getBuffer());
    const next = new Framer(client);
    next.addEncodedPacket(serializer.createPacketBuffer({ name: "network_stack_latency", params: { timestamp: 124n, needs_response: true } }));
    send(next.getBuffer());
  } else {
    Connection.prototype.handle.call(client, batch.encode());
  }
  expect(client.close).not.toHaveBeenCalled();
  expect(errors).toEqual([]);
  expect(badPacketHandler).not.toHaveBeenCalled();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("Invalid tag: 115 > 20");
  expect(warnings[0]).toContain("block_entity_data");
  expect(warnings[0]).toContain(version);
  expect(sentWire).toEqual([123, ...(encrypted ? [124] : [])].map(timestamp => Buffer.from([0x73, timestamp, 0, 0, 0, 0, 0, 0, 0, 0])));
  expect(health).toEqual([19]);
});

it("keeps truncated, pre-spawn and unrelated errors terminal", () => {
  for (const [packet, spawned] of [[invalidBlockNbt, false], [Buffer.from([0x38, 0x00]), true]] as const) {
    const { client, errors, warnings } = setup("1.26.51", spawned);
    client.readPacket(packet);
    expect(client.close).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("version 1.26.51; protocol 2193");
    expect(warnings).toEqual([]);
  }
  const { recovery } = setup("1.26.51");
  expect(recovery.recover(new Error("Invalid tag: 115 > 20"))).toBe(false);
});

it("rejects incomplete batch frames before allocating an uninitialized payload", () => {
  installBedrockFrameValidation();
  expect(() => Framer.getPackets(Buffer.from([8, 0x38, 0]))).toThrow("8 bytes declared, 2 available");
  expect(() => splitBedrockFrames(Buffer.from([8, 0x38, 0]))).toThrow("8 bytes declared, 2 available");
  expect(() => splitBedrockFrames(Buffer.from([0x80]))).toThrow("incomplete packet length/header VarInt");
  expect(() => splitBedrockFrames(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x10]))).toThrow("invalid packet length/header VarInt");
  expect(splitBedrockFrames(Buffer.from([2, 1, 2, 1, 3]))).toEqual([Buffer.from([1, 2]), Buffer.from([3])]);
});

const emptyItem = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: undefined });
const stack = (stackId = 99) => ({ network_id: 1, count: 64, metadata: 0, has_stack_id: true, stack_id: stackId, block_runtime_id: 0,
  extra: { has_nbt: "false", can_place_on: [], can_destroy: [] },
});
const containerName = { container_id: "inventory", dynamic_container_id: undefined };

function invalidInventorySlot(serializer: any): Buffer {
  const packet = serializer.createPacketBuffer({ name: "inventory_slot", params: {
    window_id: "inventory", slot: 0, container: containerName, storage_item: emptyItem(),
    item: { ...stack(), extra: { has_nbt: true, nbt: { version: 1, nbt: { type: "compound", name: "", value: {} } }, can_place_on: [], can_destroy: [] } },
  } });
  const start = packet.indexOf(Buffer.from([0xff, 0xff, 1, 0x0a, 0, 0, 0]));
  expect(start).toBeGreaterThanOrEqual(0);
  packet[start + 6] = 115; // invalid child tag; preserve the packet/item length prefixes
  return packet;
}

it.each(["1.21.50", "1.21.130", "1.26.40", "1.26.51"])("invalidates stale inventory after an NBT error and resumes only with a full %s baseline", version => {
  const { client, inventory, serializer, warnings, errors, sent } = setup(version);
  inventory.onContent({ window_id: "inventory", input: Array.from({ length: 36 }, (_, index) => index === 0 ? stack() : emptyItem()) });
  inventory.request(Date.now());
  inventory.onOpen({ window_id: "first", window_type: "container" });
  inventory.onContent({ window_id: "first", input: Array.from({ length: 27 }, emptyItem) });
  inventory.tick(Date.now());
  const requestId = sent[0].params.requests[0].request_id;
  expect(sent[0].name).toBe("item_stack_request");
  client.readPacket(invalidInventorySlot(serializer));
  expect(client.close).not.toHaveBeenCalled();
  expect(errors).toEqual([]);
  expect(warnings[0]).toContain("inventory_slot");
  expect(warnings[0]).toContain("AutoSell wartet auf vollständige Inventardaten");
  expect(inventory.synchronized).toBe(false);
  expect(sent.at(-1)!.name).toBe("container_close");
  inventory.reset(); // a world reset must not turn the lost baseline into empty stacks
  inventory.onResponse({ responses: [{ request_id: requestId, status: "ok" }] });
  client.readPacket(serializer.createPacketBuffer({ name: "inventory_slot", params: {
    window_id: "inventory", slot: 0, container: containerName, storage_item: emptyItem(), item: stack(101),
  } }));
  client.readPacket(serializer.createPacketBuffer({ name: "inventory_content", params: {
    window_id: "inventory", input: [stack(101)], container: containerName, storage_item: emptyItem(),
  } }));
  expect(inventory.synchronized).toBe(false);
  inventory.request(Date.now()); inventory.onOpen({ window_id: "first", window_type: "container" });
  inventory.onContent({ window_id: "first", input: Array.from({ length: 27 }, emptyItem) });
  inventory.tick(Date.now());
  expect(sent.filter(packet => packet.name === "item_stack_request")).toHaveLength(1);
  client.readPacket(serializer.createPacketBuffer({ name: "inventory_content", params: {
    window_id: "inventory", input: Array.from({ length: 36 }, (_, index) => index === 0 ? stack(101) : emptyItem()),
    container: containerName, storage_item: emptyItem(),
  } }));
  expect(inventory.synchronized).toBe(true);
  inventory.tick(Date.now());
  const requests = sent.filter(packet => packet.name === "item_stack_request");
  expect(requests).toHaveLength(2);
  expect(requests[1].params.requests[0].actions[0].source.stack_id).toBe(101);
});

it("keeps manual commands working while automatic sales wait for inventory recovery", () => {
  const { client, inventory, serializer, behavior, sent } = setup("1.26.51");
  behavior.updateConfig({ autosell_enabled: true, autosell_interval_seconds: 1 });
  behavior.markSpawned();
  client.readPacket(invalidInventorySlot(serializer));
  vi.advanceTimersByTime(10_000); behavior.onTick();
  expect(sent.filter(packet => packet.name === "command_request")).toEqual([]);
  behavior.enqueueChat("/home farm"); behavior.onTick();
  expect(sent.find(packet => packet.name === "command_request")!.params.command).toBe("/home farm");
  inventory.onContent({ window_id: "inventory", input: Array.from({ length: 36 }, emptyItem) });
  vi.advanceTimersByTime(5_000); behavior.onTick();
  expect(sent.filter(packet => packet.name === "command_request").map(packet => packet.params.command)).toEqual(["/home farm", "/sell"]);
});

it("does not discard a malformed item registry even after spawn", () => {
  const { client, serializer, errors, warnings } = setup("1.26.51");
  const packet = serializer.createPacketBuffer({ name: "item_registry", params: { itemstates: [{
    name: "minecraft:shield", runtime_id: 355, component_based: false, version: "legacy",
    nbt: { type: "compound", name: "", value: {} },
  }] } });
  packet[packet.length - 1] = 115;
  client.readPacket(packet);
  expect(client.close).toHaveBeenCalledOnce();
  expect(errors[0].message).toContain("item_registry");
  expect(errors[0].message).toContain("Invalid tag: 115 > 20");
  expect(warnings).toEqual([]);
});

it("rate-limits NBT warnings and still reports an inventory pause after a cosmetic failure", () => {
  const { client, serializer, warnings } = setup("1.26.51");
  for (let index = 0; index < 100; index++) client.readPacket(invalidBlockNbt);
  expect(warnings).toHaveLength(1);
  client.readPacket(invalidInventorySlot(serializer));
  expect(warnings).toHaveLength(2);
  expect(warnings[1]).toContain("AutoSell wartet auf vollständige Inventardaten");
  vi.advanceTimersByTime(30_000);
  client.readPacket(invalidBlockNbt);
  expect(warnings).toHaveLength(3);
  expect(warnings[2]).toContain("verworfen insgesamt 102");
  expect(client.close).not.toHaveBeenCalled();
});

it("uses valid network-NBT menu titles and removes cached titles after an unreadable packet", () => {
  const { client, inventory, serializer } = setup("1.26.51");
  const valid = serializer.createPacketBuffer({ name: "block_entity_data", params: {
    position: { x: 0, y: 64, z: 0 }, nbt: { type: "compound", name: "", value: { CustomName: { type: "string", value: "Items verkaufen" } } },
  } });
  client.readPacket(valid);
  inventory.onOpen({ window_id: "first", window_type: "container", coordinates: { x: 0, y: 64, z: 0 } });
  expect(inventory.busy).toBe(true);
  inventory.onClose({ window_id: "first" });
  client.readPacket(valid);
  client.readPacket(invalidBlockNbt);
  inventory.onOpen({ window_id: "first", window_type: "container", coordinates: { x: 0, y: 64, z: 0 } });
  expect(inventory.busy).toBe(false);
  expect(inventory.blocked).toBe(true);
});
