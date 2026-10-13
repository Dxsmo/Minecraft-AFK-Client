import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installBedrockNetworkNbtArrays } from "../../src/bedrock-bot/networkNbt.js";
import { BedrockPacketRecovery } from "../../src/bedrock-bot/packetRecovery.js";
import { BedrockInventory } from "../../src/bedrock-bot/inventory.js";
import { BotSender } from "../../src/bedrock-bot/send.js";

const require = createRequire(import.meta.url);
const nbt = require("prismarine-nbt");
const { createDeserializer, createSerializer } = require("bedrock-protocol/src/transforms/serializer");
const { Client } = require("bedrock-protocol/src/client");
const { Versions } = require("bedrock-protocol/src/options");
const { ClientStatus } = require("bedrock-protocol/src/connection");
const original = Object.fromEntries(["readCtx", "writeCtx", "sizeOfCtx"].map(context => [context,
  Object.fromEntries(["intArray", "longArray"].map(name => [name, nbt.protos.littleVarint[context][name]])),
]));

beforeEach(() => vi.spyOn(process.stdout, "write").mockImplementation(() => true));
afterEach(() => {
  for (const context of Object.keys(original)) Object.assign(nbt.protos.littleVarint[context], original[context]);
  vi.restoreAllMocks();
});

// Independent Cloudburst-compatible network encodings. Expected bytes never
// come from Prismarine's encoder, which previously shared the decoder's bug.
function uint(value: bigint): Buffer {
  const bytes: number[] = [];
  do {
    const byte = Number(value & 127n);
    value >>= 7n;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}
const int = (value: number) => uint((BigInt(value) << 1n) ^ (BigInt(value) >> 31n));
const long = (value: bigint) => uint((value << 1n) ^ (value >> 63n));
function string(value: string): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([uint(BigInt(bytes.length)), bytes]);
}
function tag(type: number, name: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type]), string(name), payload]);
}
function root(tags: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([10, 0]), ...tags, Buffer.from([0])]);
}
function titlePacket(): Buffer {
  return Buffer.concat([
    Buffer.from([0x38]), int(21), int(0), int(12),
    root([
      tag(11, "bounds", Buffer.concat([int(2), int(128), int(129)])),
      tag(8, "CustomName", string("Items verkaufen".padEnd(92, " "))),
    ]),
  ]);
}

it.each(["1.21.50", "1.21.130", "1.26.40", "1.26.51"])("correctly decodes and re-encodes a legal 125-byte %s block packet that originally threw tag 115", version => {
  // Construct codecs *before* installing the patch, like createClient's import
  // path. Updating the existing NBT context must reach these captured codecs.
  const parser = createDeserializer(version);
  const serializer = createSerializer(version);
  const packet = titlePacket();
  expect(packet.length).toBe(125);
  expect(() => parser.parsePacketBuffer(packet)).toThrow("Invalid tag: 115 > 20");
  installBedrockNetworkNbtArrays();
  const result = parser.parsePacketBuffer(packet);
  expect(result.metadata.size).toBe(packet.length);
  expect(result.data.name).toBe("block_entity_data");
  expect(result.data.params.position).toEqual({ x: 21, y: 0, z: 12 });
  expect(result.data.params.nbt.value.bounds.value).toEqual([128, 129]);
  expect(result.data.params.nbt.value.CustomName.value).toBe("Items verkaufen".padEnd(92, " "));
  expect(serializer.createPacketBuffer(result.data)).toEqual(packet);
});

it("preserves signed int/long boundaries, nested arrays and the following string tag", () => {
  const ints = [0, -1, 1, 127, -128, 128, 16_384, -16_385, -2_147_483_648, 2_147_483_647];
  const longs = [0n, -1n, 1n, 127n, -128n, 128n, 16_384n, -16_385n, -(1n << 63n), (1n << 63n) - 1n];
  const packet = root([
    tag(10, "nested", Buffer.concat([
      tag(11, "ints", Buffer.concat([int(ints.length), ...ints.map(int)])),
      tag(12, "longs", Buffer.concat([int(longs.length), ...longs.map(long)])),
      tag(8, "after", string("Grüße 🐾")), Buffer.from([0]),
    ])),
  ]);
  installBedrockNetworkNbtArrays();
  const parsed = nbt.protos.littleVarint.parsePacketBuffer("nbt", packet);
  expect(parsed.metadata.size).toBe(packet.length);
  expect(parsed.data.value.nested.value.ints.value).toEqual(ints);
  expect(parsed.data.value.nested.value.longs.value).toEqual(longs);
  expect(parsed.data.value.nested.value.after.value).toBe("Grüße 🐾");
  expect(nbt.writeUncompressed(parsed.data, "littleVarint")).toEqual(packet);
});

it("keeps empty arrays legal and rejects negative counts or truncated elements", () => {
  installBedrockNetworkNbtArrays();
  for (const [type, name] of [[11, "intArray"], [12, "longArray"]] as const) {
    const empty = root([tag(type, "a", int(0))]);
    expect(nbt.protos.littleVarint.parsePacketBuffer("nbt", empty).data.value.a.value).toEqual([]);
    expect(() => nbt.protos.littleVarint.parsePacketBuffer("nbt", root([tag(type, "a", int(-1))]))).toThrow(`Negative network NBT ${name} length`);
    expect(() => nbt.protos.littleVarint.parsePacketBuffer("nbt", root([tag(type, "a", Buffer.from([20, 0x80]))]))).toThrow();
  }
});

it("does not change little-endian item NBT or big-endian Java NBT arrays", () => {
  const littleReader = nbt.protos.little.readCtx.intArray;
  const bigReader = nbt.protos.big.readCtx.intArray;
  installBedrockNetworkNbtArrays();
  expect(nbt.protos.little.readCtx.intArray).toBe(littleReader);
  expect(nbt.protos.big.readCtx.intArray).toBe(bigReader);
  const packet = Buffer.from([10, 0, 0, 11, 1, 0, 97, 2, 0, 0, 0, 128, 0, 0, 0, 129, 0, 0, 0, 0]);
  const parsed = nbt.protos.little.parsePacketBuffer("nbt", packet);
  expect(parsed.metadata.size).toBe(packet.length);
  expect(parsed.data.value.a.value).toEqual([128, 129]);
  expect(nbt.writeUncompressed(parsed.data, "little")).toEqual(packet);
});

it("delivers the repaired menu title to inventory without warning, discarding or disconnecting", () => {
  const version = "1.26.51";
  const client = new Client({ version, delayedInit: true, offline: true, conLog: null });
  client.options.protocolVersion = Versions[version];
  client.deserializer = createDeserializer(version);
  client.status = ClientStatus.Initialized;
  const inventory = new BedrockInventory(new BotSender(client, "Bot"));
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const recovery = new BedrockPacketRecovery(client, inventory, () => true, message => warnings.push(message));
  client.on("error", (error: unknown) => { if (!recovery.recover(error)) errors.push(error); });
  const receive = vi.fn(packet => inventory.onBlockEntity(packet));
  client.on("block_entity_data", receive);
  installBedrockNetworkNbtArrays();
  client.readPacket(titlePacket());
  expect(receive).toHaveBeenCalledOnce();
  expect(warnings).toEqual([]);
  expect(errors).toEqual([]);
  inventory.onOpen({ window_id: "first", window_type: "container", coordinates: { x: 21, y: 0, z: 12 } });
  expect(inventory.busy).toBe(true);
  expect(inventory.blocked).toBe(false);
});
