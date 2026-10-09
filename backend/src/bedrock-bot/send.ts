// Outbound Bedrock actions. Packet failures remain retryable and are logged.

import { emit, type OutEvent } from "./protocol.js";

type AnyClient = {
  queue(name: string, params: object): void;
  write(name: string, params: object): void;
  versionGreaterThanOrEqualTo?(version: string): boolean;
  entityId?: bigint;
};

/** All-zero UUID: the command_request `uuid` field must be a valid UUID string. */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function warn(message: string): void {
  emit({ type: "warning", message } satisfies OutEvent);
}

export class BotSender {
  private client: AnyClient;
  private username: string;
  /** Runtime entity id captured from start_game; needed by some action packets. */
  private runtimeEntityId: bigint | null = null;
  private position: { x: number; y: number; z: number } | null = null;
  private pitch = 0;
  private yaw = 0;
  private inputTick = 0n;
  private sneaking = false;
  private sneakEdge = true;
  private releaseForSneakResync = false;
  private sneakPressPending = false;
  private handledTeleport = false;
  private lastWarningAt = new Map<string, number>();
  authoritativeInventory = true;

  constructor(client: AnyClient, username: string) {
    this.client = client;
    this.username = username;
  }

  setRuntimeEntityId(id: bigint | null): void {
    this.runtimeEntityId = id ?? this.runtimeEntityId;
  }

  /** Send a chat message, or run a slash command if the text starts with "/". */
  send(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/")) {
      this.command(trimmed);
    } else {
      this.chatText(trimmed);
    }
  }

  /** Run a slash command via command_request, falling back to chat text. */
  command(text: string): void {
    const command = text.startsWith("/") ? text : `/${text}`;
    // The command_request schema differs by protocol: `version` is a varint on
    // older versions (< 1.21.130) and a string on newer ones, and the origin
    // needs a valid UUID (empty string throws during serialization — which is
    // why the old code silently fell back to chat and commands never ran).
    // bedrock-protocol serializes synchronously in queue(), so we can try the
    // best-guess shape and, if it throws, try the other version encoding.
    const origin = {
      type: "player" as const,
      uuid: ZERO_UUID,
      request_id: "",
      // Only present in the newer schema; ignored by protodef on older ones.
      player_entity_id: 0,
    };
    const newSchema =
      typeof this.client.versionGreaterThanOrEqualTo === "function"
        ? this.client.versionGreaterThanOrEqualTo("1.21.130")
        : true;
    const primaryVersion: string | number = newSchema ? "66" : 66;
    const fallbackVersion: string | number = newSchema ? 66 : "66";

    if (this.tryCommand(command, origin, primaryVersion)) return;
    if (this.tryCommand(command, origin, fallbackVersion)) return;
    // Last resort: some servers execute commands typed as plain chat text.
    this.chatText(command);
  }

  private tryCommand(command: string, origin: object, version: string | number): boolean {
    try {
      this.client.queue("command_request", { command, origin, internal: false, version });
      return true;
    } catch {
      return false;
    }
  }

  /** Send a raw chat message (client -> server text packet). */
  chatText(message: string): void {
    try {
      this.client.queue("text", {
        type: "chat",
        needs_translation: false,
        source_name: this.username,
        xuid: "",
        platform_chat_id: "",
        message,
        filtered_message: "",
      });
    } catch (err) {
      warn(`Failed to send chat: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Use only the server's own player position, never coordinates of nearby entities. */
  updatePosition(position: unknown, pitch = 0, yaw = 0, teleport = false): void {
    const p = position as { x?: number; y?: number; z?: number } | null;
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return;
    this.position = { x: p.x!, y: p.y!, z: p.z! };
    this.pitch = Number.isFinite(pitch) ? pitch : this.pitch;
    this.yaw = Number.isFinite(yaw) ? yaw : this.yaw;
    this.handledTeleport ||= teleport;
    this.sneakEdge ||= teleport;
  }

  setInputTick(tick: bigint): void { this.inputTick = tick; }

  /** Geyser caches Java input: START alone may leave its held shift unchanged
   * after a proxy transfer. A resync sends release and press in separate ticks. */
  setSneak(sneaking: boolean, resync = false): void {
    if (sneaking && resync && this.sneaking && !this.sneakPressPending) this.releaseForSneakResync = true;
    if (!sneaking) { this.releaseForSneakResync = false; this.sneakPressPending = false; }
    this.sneaking = sneaking;
    this.sneakEdge = true;
  }

  /** Only the local player's authoritative flags count as sneak confirmation. */
  observeSneakMetadata(packet: unknown): boolean | null {
    const p = packet as { runtime_entity_id?: unknown; metadata?: { key?: unknown; value?: unknown }[] } | null;
    try {
      if (p?.runtime_entity_id == null || BigInt(p.runtime_entity_id as bigint) !== this.runtimeEntityId || !Array.isArray(p.metadata)) return null;
      const flags = p.metadata.find(entry => entry.key === "flags" || entry.key === 0)?.value;
      if (flags && typeof flags === "object" && "sneaking" in flags && typeof flags.sneaking === "boolean") return flags.sneaking;
      if (typeof flags === "bigint" || (typeof flags === "number" && Number.isSafeInteger(flags))) return (BigInt(flags) & 2n) !== 0n;
    } catch { /* Ignore malformed or unrelated metadata. */ }
    return null;
  }

  /** Modern Bedrock/Geyser reads held keys from PlayerAuthInput every game tick. */
  tickInput(): boolean {
    if (this.runtimeEntityId == null || !this.position) return false;
    const heldSneak = this.sneaking && !this.releaseForSneakResync;
    const inputFlags = {
      sneaking: heldSneak, sneak_down: heldSneak, sneak_current_raw: heldSneak,
      persist_sneak: heldSneak,
      start_sneaking: heldSneak && this.sneakEdge,
      stop_sneaking: !heldSneak && this.sneakEdge,
      sneak_pressed_raw: heldSneak && this.sneakEdge,
      sneak_released_raw: !heldSneak && this.sneakEdge,
      handled_teleport: this.handledTeleport,
    };
    const sent = this.packet("player_auth_input", {
      pitch: this.pitch, yaw: this.yaw, head_yaw: this.yaw, position: this.position,
      move_vector: { x: 0, z: 0 }, analogue_move_vector: { x: 0, z: 0 }, raw_move_vector: { x: 0, z: 0 },
      // From 26.40 onward the codec expects a list, not a bitflags object;
      // passing the old shape serializes an empty list and silently loses crouch.
      input_data: this.client.versionGreaterThanOrEqualTo?.("1.26.40")
        ? Object.entries(inputFlags).filter(([, enabled]) => enabled).map(([flag]) => flag)
        : inputFlags,
      input_mode: "mouse", play_mode: "normal", interaction_model: "crosshair",
      interact_rotation: { x: this.pitch, z: this.yaw },
      tick: ++this.inputTick, delta: { x: 0, y: 0, z: 0 },
      camera_orientation: {
        x: -Math.sin(this.yaw * Math.PI / 180) * Math.cos(this.pitch * Math.PI / 180),
        y: -Math.sin(this.pitch * Math.PI / 180),
        z: Math.cos(this.yaw * Math.PI / 180) * Math.cos(this.pitch * Math.PI / 180),
      },
    });
    if (sent) {
      if (this.releaseForSneakResync) {
        this.releaseForSneakResync = false;
        this.sneakPressPending = true;
        this.sneakEdge = true;
      } else {
        this.sneakPressPending = false;
        this.sneakEdge = false;
      }
      this.handledTeleport = false;
    }
    return sent;
  }

  packet(name: string, params: object): boolean {
    try { this.client.queue(name, params); return true; }
    catch (err) {
      const now = Date.now();
      if (now - (this.lastWarningAt.get(name) ?? -Infinity) >= 30_000) {
        this.lastWarningAt.set(name, now);
        warn(`Bedrock ${name}: ${err instanceof Error ? err.message : String(err)}; wird erneut versucht`);
      }
      return false;
    }
  }
}
