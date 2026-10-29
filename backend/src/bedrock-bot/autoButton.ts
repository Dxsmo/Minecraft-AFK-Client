import { createRequire } from "node:module";
import type { BotSender, InputFrame, PlayerView } from "./send.js";
import type { BedrockInventory } from "./inventory.js";

const require = createRequire(import.meta.url);
type Vec = { x: number; y: number; z: number };
type Mode = "off" | "left" | "right";
const key = (p: Vec) => `${p.x},${p.y},${p.z}`;
const chunk = (p: Vec): Vec => ({ x: Math.floor(p.x / 16), y: Math.floor(p.y / 16), z: Math.floor(p.z / 16) });
const finite = (p: any): p is Vec => p && [p.x, p.y, p.z].every(Number.isFinite);

/** Decode network subchunks into runtime IDs, without storing biomes or NBT.
 * Unknown/custom IDs remain opaque: they must never become transparent air. */
function readSubchunk(payload: Buffer): { blocks: Uint32Array; consumed: number; y?: number } {
  let offset = 0;
  const byte = () => { if (offset >= payload.length) throw new Error("Truncated subchunk"); return payload[offset++]; };
  const uint = () => {
    let n = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = byte();
      if (shift === 28 && b > 15) throw new Error("Overflowing subchunk varint");
      n = (n | ((b & 127) << shift)) >>> 0;
      if (!(b & 128)) return n;
    }
    throw new Error("Invalid subchunk varint");
  };
  const signed = () => { const n = uint(); return (n >>> 1) ^ -(n & 1); };
  const version = byte();
  if (version !== 8 && version !== 9) throw new Error("Unsupported subchunk");
  const layers = byte();
  const y = version === 9 ? (byte() << 24) >> 24 : undefined;
  if (layers > 2) throw new Error("Invalid storage count");
  // A zero-storage section is explicitly all air (caller supplies that ID).
  let blocks = new Uint32Array();
  for (let layer = 0; layer < layers; layer++) {
    const header = byte(), bits = header >>> 1;
    if (!(header & 1) || ![0, 1, 2, 3, 4, 5, 6, 8, 16].includes(bits)) throw new Error("Unsupported block storage");
    if (!bits) { const runtime = signed() >>> 0; if (!layer) blocks = new Uint32Array(4096).fill(runtime); continue; }
    const perWord = Math.floor(32 / bits), words = Math.ceil(4096 / perWord);
    const start = offset;
    if (start + words * 4 > payload.length) throw new Error("Truncated block storage");
    offset += words * 4;
    const count = signed();
    if (count < 1 || count > 65536) throw new Error("Invalid block palette");
    const palette = Array.from({ length: count }, () => signed() >>> 0);
    const output = new Uint32Array(4096), mask = (1 << bits) - 1;
    for (let i = 0; i < output.length; i++) {
      const word = payload.readUInt32LE(start + Math.floor(i / perWord) * 4);
      const index = (word >>> ((i % perWord) * bits)) & mask;
      if (index >= palette.length) throw new Error("Invalid palette index");
      output[i] = palette[index];
    }
    if (!layer) blocks = output;
  }
  return { blocks, consumed: offset, y };
}

export function decodeMouseSubchunk(payload: Buffer): Uint32Array { return readSubchunk(payload).blocks; }

/** Ray/box intersection, returning distance and the entered Bedrock face. */
function intersect(origin: Vec, direction: Vec, min: Vec, max: Vec): { distance: number; face: number } | null {
  let near = 0, far = 6, face = 0;
  for (const [axis, lowFace, highFace] of [["x", 4, 5], ["y", 0, 1], ["z", 2, 3]] as const) {
    const d = direction[axis];
    if (Math.abs(d) < 1e-8) { if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null; continue; }
    const a = (min[axis] - origin[axis]) / d, b = (max[axis] - origin[axis]) / d;
    const enter = Math.min(a, b), exit = Math.max(a, b);
    if (enter > near) { near = enter; face = d > 0 ? lowFace : highFace; }
    far = Math.min(far, exit);
    if (near > far) return null;
  }
  return far >= 0 ? { distance: near, face } : null;
}

/** Desired mouse input survives teleports; world targets never survive worlds.
 * Stores at most 27 nearby 16 KiB sections and 128 nearby entities per account. */
export class BedrockAutoButton {
  private mode: Mode = "off";
  private registry: any;
  private Block: any;
  private startGameData: any;
  private itemStates: any;
  private sections = new Map<string, Uint32Array>();
  private airUpdates = new Map<string, { position: Vec; block_runtime_id: number }>();
  private pending = new Map<string, number>();
  private entities = new Map<string, { runtime: bigint; unique: string; position: Vec; width: number; height: number }>();
  private dimension = 0;
  private air = 0;
  private useUntil = 0;
  private usingItem = false;
  private useRequested = false;
  private lastUseHand: BedrockInventory["mouseHand"] = null;
  private releasePending: object | null = null;
  private mining: { position: Vec; face: number; runtime: number; started: number; duration: number } | null = null;
  private lastAttack = 0;

  constructor(private sender: BotSender, private inventory: BedrockInventory, private version: string) {}

  configure(mode: Mode = "off"): void {
    if (mode === this.mode) return;
    const view = this.sender.playerView;
    const hand = this.inventory.mouseHand ?? this.lastUseHand;
    if (this.mode === "right" && this.useRequested && view && hand) this.releasePending = { transaction: {
      legacy: { legacy_request_id: 0 }, transaction_type: "item_release", actions: [],
      transaction_data: { action_type: "release", hotbar_slot: hand.slot, held_item: hand.item, head_pos: view.position },
    } };
    this.flushRelease();
    if (this.mining) this.sender.queueBlockAction({ action: "abort_break", position: this.mining.position, face: this.mining.face });
    this.mode = mode; this.mining = null; this.useUntil = 0; this.useRequested = false;
    if (mode === "off") this.pending.clear();
    else if (!this.registry && this.startGameData) this.initializeRegistry();
  }

  reset(dimension = this.dimension): void {
    this.dimension = dimension; this.sections.clear(); this.pending.clear(); this.entities.clear();
    this.airUpdates.clear();
    this.releasePending = null; this.lastUseHand = null; this.sender.clearMouseActions();
    this.mining = null; this.usingItem = false; this.useUntil = 0; this.useRequested = false;
  }

  teleported(): void {
    // The server cancels interactions on a teleport. Reapply desired input
    // against the destination without emitting a mouse-release packet.
    this.mining = null; this.usingItem = false; this.useUntil = 0; this.useRequested = false;
    this.releasePending = null; this.sender.clearMouseActions();
  }

  private flushRelease(): boolean {
    if (this.releasePending && !this.sender.packet("inventory_transaction", this.releasePending)) return false;
    this.releasePending = null;
    return true;
  }

  onStartGame(packet: any): void {
    this.reset(packet.dimension ?? 0);
    this.startGameData = { itemstates: packet.itemstates, block_network_ids_are_hashes: packet.block_network_ids_are_hashes };
    this.registry = undefined; this.Block = undefined;
    if (this.mode !== "off") this.initializeRegistry();
  }

  onItemRegistry(packet: any): void {
    if (Array.isArray(packet.itemstates)) this.itemStates = packet.itemstates;
    if (this.registry) this.initializeRegistry();
  }

  private initializeRegistry(): void {
    this.registry = require("prismarine-registry")(`bedrock_${this.version}`);
    this.registry.handleStartGame({ ...this.startGameData, itemstates: this.startGameData?.itemstates ?? this.itemStates ?? this.registry.writeItemStates() });
    this.Block = require("prismarine-block")(this.registry);
    const air = (Object.entries(this.registry.blocksByRuntimeId) as [string, any][])
      .find(([, block]) => block.stateId === this.registry.blocksByName.air.defaultState);
    this.air = air ? Number(air[0]) >>> 0 : 0;
    for (const update of this.airUpdates.values()) this.onUpdateBlock(update);
    this.airUpdates.clear();
  }

  private nearby(p: Vec): boolean {
    const view = this.sender.playerView;
    if (!view) return false;
    const center = chunk(view.position);
    return Math.abs(p.x - center.x) <= 1 && Math.abs(p.y - center.y) <= 1 && Math.abs(p.z - center.z) <= 1;
  }

  onSubchunk(packet: any): void {
    if (this.mode === "off" || !this.registry || packet.cache_enabled || packet.dimension !== this.dimension || !finite(packet.origin)) return;
    for (const entry of (packet.entries ?? []).slice(0, 256)) {
      const p = { x: packet.origin.x + entry.dx, y: packet.origin.y + entry.dy, z: packet.origin.z + entry.dz };
      if (!this.nearby(p) || !this.pending.has(key(p))) continue;
      try {
        const values = entry.result === "success_all_air" ? new Uint32Array(4096).fill(this.air)
          : entry.result === "success" && Buffer.isBuffer(entry.payload) && entry.payload.length <= 256_000 ? decodeMouseSubchunk(entry.payload) : null;
        if (!values) continue;
        this.sections.set(key(p), values);
        this.pending.delete(key(p));
      } catch { /* Unknown chunk encoding stays unavailable and is requested again. */ }
    }
  }

  /** Geyser sends complete level chunks instead of on-demand subchunks. Keep
   * only the sections around the player, also before the user enables input. */
  onLevelChunk(packet: any): void {
    if (packet.cache_enabled || !Buffer.isBuffer(packet.payload) || !Number.isInteger(packet.x) || !Number.isInteger(packet.z)) return;
    if (packet.dimension != null && packet.dimension !== this.dimension) return;
    const count = packet.sub_chunk_count;
    if (!Number.isInteger(count) || count < 0 || count > 24) return;
    const view = this.sender.playerView;
    if (!view || Math.abs(packet.x - chunk(view.position).x) > 1 || Math.abs(packet.z - chunk(view.position).z) > 1) return;
    let offset = 0;
    try {
      const decoded: Array<[string, Uint32Array]> = [];
      for (let i = 0; i < count; i++) {
        const section = readSubchunk(packet.payload.subarray(offset)); offset += section.consumed;
        const p = { x: packet.x, y: section.y ?? i + (this.dimension === 0 ? -4 : 0), z: packet.z };
        if (this.nearby(p)) decoded.push([key(p), section.blocks]);
      }
      for (const [id, data] of decoded) {
        this.sections.set(id, data); this.pending.delete(id);
        for (const [blockId, update] of this.airUpdates) if (key(chunk(update.position)) === id) this.airUpdates.delete(blockId);
      }
      for (const [id] of this.sections) { const [x, y, z] = id.split(",").map(Number); if (!this.nearby({ x, y, z })) this.sections.delete(id); }
    } catch { /* Leave existing authoritative sections unchanged on malformed data. */ }
  }

  onUpdateBlock(packet: any): void {
    if (!finite(packet.position) || (packet.layer ?? 0) !== 0) return;
    const id = key(chunk(packet.position));
    let section = this.sections.get(id);
    if (section && Number.isInteger(packet.block_runtime_id)) {
      // Empty arrays stand for explicit all-air sections. Materialize lazily.
      if (!section.length) {
        if (!this.registry) {
          this.airUpdates.set(key(packet.position), { position: { ...packet.position }, block_runtime_id: packet.block_runtime_id });
          if (this.airUpdates.size > 1024) { this.sections.clear(); this.airUpdates.clear(); }
          return;
        }
        this.sections.set(id, section = new Uint32Array(4096).fill(this.air));
      }
      const { x, y, z } = packet.position;
      section[((x & 15) << 8) | ((z & 15) << 4) | (y & 15)] = packet.block_runtime_id >>> 0;
    }
  }

  onEntity(name: string, packet: any): void {
    if (name === "remove_entity") {
      for (const [id, entity] of this.entities) if (entity.unique === String(packet.entity_id_self)) this.entities.delete(id);
      return;
    }
    const runtime = packet.runtime_entity_id ?? packet.runtime_id;
    if (name === "move_entity_delta") {
      const old = this.entities.get(String(runtime));
      if (!old) return;
      packet = { ...packet, position: { x: packet.x ?? old.position.x, y: packet.y ?? old.position.y, z: packet.z ?? old.position.z } };
    }
    if (runtime == null || String(runtime) === String(this.sender.localEntityId) || !finite(packet.position)) return;
    const id = String(runtime), old = this.entities.get(id);
    if (!old && name !== "add_entity" && name !== "add_player") return;
    const view = this.sender.playerView;
    if (!view || Math.hypot(packet.position.x - view.position.x, packet.position.y - view.position.y, packet.position.z - view.position.z) > 12) { this.entities.delete(id); return; }
    const data = this.registry?.entitiesByName?.[String(packet.entity_type).replace("minecraft:", "")];
    this.entities.set(id, { runtime: BigInt(runtime), unique: String(packet.unique_id ?? packet.entity_id_self ?? old?.unique),
      position: name === "add_player" || name === "move_player" ? { ...packet.position, y: packet.position.y - 1.62 } : { ...packet.position },
      width: old?.width ?? data?.width ?? 0.6, height: old?.height ?? data?.height ?? 1.8 });
    if (this.entities.size > 128) this.entities.delete(this.entities.keys().next().value!);
  }

  observeMetadata(packet: any): void {
    if (String(packet.runtime_entity_id) !== String(this.sender.localEntityId)) return;
    const flags = packet.metadata?.find((v: any) => v.key === "flags" || v.key === 0)?.value;
    if (flags && typeof flags === "object" && typeof (flags.using_item ?? flags.usingitem) === "boolean") this.usingItem = flags.using_item ?? flags.usingitem;
    else if (typeof flags === "bigint") this.usingItem = (flags & 16n) !== 0n;
  }

  private requestSections(view: PlayerView, now: number): void {
    const center = chunk(view.position), requests: Array<Vec & { dx: number; dy: number; dz: number }> = [];
    for (const [id] of this.sections) { const [x, y, z] = id.split(",").map(Number); if (!this.nearby({ x, y, z })) this.sections.delete(id); }
    for (const [id] of this.pending) { const [x, y, z] = id.split(",").map(Number); if (!this.nearby({ x, y, z })) this.pending.delete(id); }
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) {
      const p = { x: center.x + x, y: center.y + y, z: center.z + z }, id = key(p);
      if (p.y < -4 || p.y > 19 || this.sections.has(id) || now - (this.pending.get(id) ?? -Infinity) < 2000) continue;
      // Older codecs name these dx/dy/dz, newer codecs use vec3i8 x/y/z.
      requests.push({ x, y, z, dx: x, dy: y, dz: z }); this.pending.set(id, now);
    }
    if (requests.length) this.sender.packet("subchunk_request", { dimension: this.dimension, origin: center, requests });
  }

  private target(view: PlayerView): { block: any; position: Vec; runtime: number; distance: number; face: number; point: Vec } | null | undefined {
    const d = view.direction, o = view.position;
    const visited = new Set<string>();
    for (let distance = 0; distance <= 5; distance += 0.05) {
      const p = { x: Math.floor(o.x + d.x * distance), y: Math.floor(o.y + d.y * distance), z: Math.floor(o.z + d.z * distance) };
      const id = key(p); if (visited.has(id)) continue; visited.add(id);
      const section = this.sections.get(key(chunk(p)));
      if (!section) return undefined;
      const runtime = section.length ? section[((p.x & 15) << 8) | ((p.z & 15) << 4) | (p.y & 15)] : this.air;
      const data = this.registry.blocksByRuntimeId[runtime] ?? this.registry.blocksByRuntimeId[runtime | 0];
      if (!data) return undefined;
      const block = this.Block.fromStateId(data.stateId, 0);
      const hits = (block.shapes ?? []).map((s: number[]) => intersect(o, d,
        { x: p.x + s[0], y: p.y + s[1], z: p.z + s[2] }, { x: p.x + s[3], y: p.y + s[4], z: p.z + s[5] }))
        .filter((h: any) => h && h.distance <= 5).sort((a: any, b: any) => a.distance - b.distance);
      if (hits.length) { const hit = hits[0]; return { block, position: p, runtime, ...hit,
        point: { x: o.x + d.x * hit.distance, y: o.y + d.y * hit.distance, z: o.z + d.z * hit.distance } }; }
    }
    return null;
  }

  tick(now: number): InputFrame {
    if (!this.flushRelease()) return {};
    const view = this.sender.playerView;
    if (!view || this.mode === "off" || !this.registry) return {};
    this.requestSections(view, now);
    const hand = this.inventory.mouseHand;
    if (!hand || this.inventory.mouseBlocked) return {};
    const target = this.target(view);
    // Unknown world data cannot safely become a click through a wall.
    if (target === undefined) return {};
    const entity = [...this.entities.values()].map(entity => ({ entity, hit: intersect(view.position, view.direction,
      { x: entity.position.x - entity.width / 2, y: entity.position.y, z: entity.position.z - entity.width / 2 },
      { x: entity.position.x + entity.width / 2, y: entity.position.y + entity.height, z: entity.position.z + entity.width / 2 }) }))
      .filter(({ hit }) => hit && hit.distance <= 3 && hit.distance < (target?.distance ?? 5))
      .sort((a, b) => a.hit!.distance - b.hit!.distance)[0];
    if (entity) {
      if (now >= this.lastAttack && this.sender.packet("inventory_transaction", { transaction: { legacy: { legacy_request_id: 0 }, actions: [], transaction_type: "item_use_on_entity",
        transaction_data: { entity_runtime_id: entity.entity.runtime, action_type: this.mode === "left" ? "attack" : "interact",
          hotbar_slot: hand.slot, held_item: hand.item, player_pos: view.position, click_pos: { x: 0, y: entity.entity.height / 2, z: 0 } } } })) this.lastAttack = now + (this.mode === "left" ? 500 : 200);
      if (this.mining) {
        const previous = this.mining;
        return { blockActions: [{ action: "abort_break", position: previous.position, face: previous.face }], sent: () => { this.mining = null; } };
      }
      return {};
    }
    if (this.mode === "right") {
      if (this.usingItem || now < this.useUntil) return {};
      const p = target?.position ?? { x: 0, y: 0, z: 0 };
      return { flags: { item_interact: true, start_using_item: !this.useRequested }, transaction: {
        legacy: { legacy_request_id: 0 }, actions: [], data: {
          action_type: target ? "click_block" : "click_air", trigger_type: "player_input", block_position: p,
          face: target?.face ?? 0, hotbar_slot: hand.slot, hand: "main_hand", held_item: hand.item,
          player_pos: view.position, click_pos: target ? { x: target.point.x - p.x, y: target.point.y - p.y, z: target.point.z - p.z } : { x: 0, y: 0, z: 0 },
          block_runtime_id: target?.runtime ?? 0, client_prediction: "failure", client_cooldown_state: "off",
        } }, sent: () => { this.useUntil = now + 200; this.useRequested = true; this.lastUseHand = hand; } };
    }
    const actions: object[] = [];
    if (this.mining && (!target || key(this.mining.position) !== key(target.position) || this.mining.runtime !== target.runtime)) {
      actions.push({ action: "abort_break", position: this.mining.position, face: this.mining.face }); this.mining = null;
    }
    if (target) {
      const action = { position: target.position, face: target.face };
      if (!this.mining) {
        const duration = target.block.digTime(hand.item.network_id, false, false, false);
        actions.push({ ...action, action: "start_break" });
        return { blockActions: actions, sent: () => { this.mining = { ...action, runtime: target.runtime, started: now, duration }; } };
      }
      if (now - this.mining.started >= this.mining.duration) {
        actions.push({ ...action, action: "predict_break" });
        // Await the authoritative update; retry rejected predictions after 1s.
        return { blockActions: actions, sent: () => { if (this.mining) this.mining.started = now + 1000 - this.mining.duration; } };
      }
      actions.push({ ...action, action: "continue_break" });
    }
    return actions.length ? { blockActions: actions } : {};
  }
}
