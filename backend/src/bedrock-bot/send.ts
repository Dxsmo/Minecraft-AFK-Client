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

  setSneak(sneaking: boolean): void {
    this.sneaking = sneaking;
    this.sneakEdge = true;
  }

  /** Modern Bedrock/Geyser reads held keys from PlayerAuthInput every game tick. */
  tickInput(): boolean {
    if (this.runtimeEntityId == null || !this.position) return false;
    const sent = this.packet("player_auth_input", {
      pitch: this.pitch, yaw: this.yaw, head_yaw: this.yaw, position: this.position,
      move_vector: { x: 0, z: 0 }, analogue_move_vector: { x: 0, z: 0 }, raw_move_vector: { x: 0, z: 0 },
      input_data: {
        sneaking: this.sneaking, sneak_down: this.sneaking, sneak_current_raw: this.sneaking,
        start_sneaking: this.sneaking && this.sneakEdge,
        stop_sneaking: !this.sneaking && this.sneakEdge,
        sneak_pressed_raw: this.sneaking && this.sneakEdge,
        sneak_released_raw: !this.sneaking && this.sneakEdge,
        handled_teleport: this.handledTeleport,
      },
      input_mode: "mouse", play_mode: "normal", interaction_model: "crosshair",
      interact_rotation: { x: this.pitch, z: this.yaw },
      tick: ++this.inputTick, delta: { x: 0, y: 0, z: 0 },
      camera_orientation: {
        x: -Math.sin(this.yaw * Math.PI / 180) * Math.cos(this.pitch * Math.PI / 180),
        y: -Math.sin(this.pitch * Math.PI / 180),
        z: Math.cos(this.yaw * Math.PI / 180) * Math.cos(this.pitch * Math.PI / 180),
      },
    });
    if (sent) { this.sneakEdge = false; this.handledTeleport = false; }
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
