import { createRequire } from "node:module";
import type { BedrockInventory } from "./inventory.js";

const require = createRequire(import.meta.url);
const minecraftData = require("minecraft-data") as (version: string) => {
  version: { version: number };
  protocol: { types: { mcpe_packet: [string, Array<{ name: string; type: [string, { mappings: Record<string, string> }] }>] } };
};

function unsignedVarint(buffer: Buffer, offset: number): { value: number; size: number } {
  let value = 0;
  for (let index = 0; index < 5; index++) {
    if (offset + index >= buffer.length) throw new Error("Bedrock: incomplete packet length/header VarInt");
    const byte = buffer[offset + index];
    if (index === 4 && (byte & 0xf0) !== 0) throw new Error("Bedrock: invalid packet length/header VarInt");
    value += (byte & 0x7f) * 2 ** (7 * index);
    if ((byte & 0x80) === 0) return { value, size: index + 1 };
  }
  throw new Error("Bedrock: invalid packet length/header VarInt");
}

/** A decrypted/decompressed batch must contain complete length-prefixed packets.
 * Upstream allocates the advertised length even if fewer bytes remain, exposing
 * an uninitialized tail to the NBT decoder. Reject the entire bad batch first. */
export function splitBedrockFrames(buffer: Buffer): Buffer[] {
  const spans: Array<[number, number]> = [];
  let offset = 0;
  while (offset < buffer.length) {
    const { value: length, size } = unsignedVarint(buffer, offset);
    offset += size;
    if (length > buffer.length - offset) {
      throw new Error(`Bedrock: incomplete batch packet (${length} bytes declared, ${buffer.length - offset} available)`);
    }
    spans.push([offset, offset + length]);
    offset += length;
  }
  return spans.map(([start, end]) => Buffer.from(buffer.subarray(start, end)));
}

export function installBedrockFrameValidation(): void {
  const { Framer } = require("bedrock-protocol/src/transforms/framer") as {
    Framer: { getPackets: typeof splitBedrockFrames };
  };
  Framer.getPackets = splitBedrockFrames;
}

export type BedrockDecodeClient = {
  options: { version: string; protocolVersion?: number };
  deserializer: { parsePacketBuffer(packet: Buffer): unknown };
};

class BedrockPacketReadError extends Error {
  constructor(
    readonly packetName: string | null,
    id: number | null,
    bytes: number,
    version: string,
    protocol: number,
    readonly decodeMessage: string,
    cause: unknown,
  ) {
    super(`Bedrock packet ${packetName ?? "unknown"} (${id == null ? "unknown ID" : `0x${id.toString(16)}`}; ${bytes} bytes; version ${version}; protocol ${protocol}): ${decodeMessage}`, { cause });
    this.name = "BedrockPacketReadError";
  }
}

// None of these packets changes encryption, protocol state, the local player's
// position or an item registry. Their failed NBT payload is never partly applied.
const recoverableGamePackets = new Set([
  "add_player", "add_entity", "add_item_entity", "mob_equipment", "mob_armor_equipment",
  "set_entity_data", "crafting_data", "crafting_event", "update_trade", "update_equipment",
  "available_entity_identifiers", "level_event_generic", "structure_template_data_export_response",
  "position_tracking_db_broadcast", "creative_content", "sync_entity_property", "add_volume_entity",
  "editor_network", "jigsaw_structure_data", "update_block_properties", "block_entity_data",
  "inventory_content", "inventory_slot", "inventory_transaction",
]);
const inventoryPackets = new Set(["inventory_content", "inventory_slot", "inventory_transaction"]);

/** Keep the original strict decoder. Only a complete, identified game packet
 * with an Invalid-tag NBT error may be discarded after the player has spawned. */
export class BedrockPacketRecovery {
  private lastWarningAt = -Infinity;
  private lastInventoryWarningAt = -Infinity;
  private skipped = 0;

  constructor(
    client: BedrockDecodeClient,
    private inventory: BedrockInventory,
    private isSpawned: () => boolean,
    private warn: (message: string) => void,
  ) {
    const version = client.options.version;
    const data = minecraftData(`bedrock_${version}`);
    const names = data.protocol.types.mcpe_packet[1].find(field => field.name === "name")!.type[1].mappings;
    const protocol = client.options.protocolVersion ?? data.version.version;
    const parse = client.deserializer.parsePacketBuffer.bind(client.deserializer);
    client.deserializer.parsePacketBuffer = (packet: Buffer) => {
      try {
        return parse(packet);
      } catch (error) {
        let id: number | null = null;
        try { id = unsignedVarint(packet, 0).value & 0x3ff; } catch { /* malformed headers remain fatal */ }
        const message = error instanceof Error ? error.message : String(error);
        throw new BedrockPacketReadError(id == null ? null : names[id] ?? null, id, packet.length, version, protocol, message, error);
      }
    };
  }

  recover(error: unknown): boolean {
    if (!(error instanceof BedrockPacketReadError) || !this.isSpawned() ||
      !error.packetName || !recoverableGamePackets.has(error.packetName) ||
      !/\bInvalid tag:\s*\d+\s*>\s*20\b/.test(error.decodeMessage)) return false;

    const inventoryError = inventoryPackets.has(error.packetName);
    if (inventoryError) this.inventory.invalidateAfterDecodeFailure();
    if (error.packetName === "block_entity_data") this.inventory.clearMenuTitles();
    this.skipped++;
    const lastWarning = inventoryError ? this.lastInventoryWarningAt : this.lastWarningAt;
    if (Date.now() - lastWarning >= 30_000) {
      if (inventoryError) this.lastInventoryWarningAt = Date.now();
      else this.lastWarningAt = Date.now();
      this.warn(`Bedrock: ungültiges NBT-Paket verworfen; Verbindung wird weiter verarbeitet; ${error.message}; verworfen insgesamt ${this.skipped}${inventoryError ? "; AutoSell wartet auf vollständige Inventardaten" : ""}`);
    }
    return true;
  }
}
