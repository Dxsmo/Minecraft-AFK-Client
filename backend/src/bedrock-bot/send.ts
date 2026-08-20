//! Outbound actions for the Bedrock bot: everything that writes packets to the
//! server. bedrock-protocol is a low-level packet client (no mineflayer-style
//! helpers), and exact packet schemas vary by protocol version. Since this code
//! cannot be exercised against a live Bedrock server in development, every send
//! is wrapped defensively: a schema mismatch emits a single warning and, for
//! optional cosmetic actions (swing/sneak/move), self-disables that action
//! rather than repeatedly throwing. Chat and command sending — the backbone of
//! the AFK/console feature set — additionally falls back from the "correct"
//! command_request packet to plain chat text, which many servers also accept.

import { emit, type OutEvent } from "./protocol.js";

type AnyClient = {
  queue(name: string, params: object): void;
  write(name: string, params: object): void;
  entityId?: bigint;
};

function warn(message: string): void {
  emit({ type: "warning", message } satisfies OutEvent);
}

export class BotSender {
  private client: AnyClient;
  private username: string;
  /** Runtime entity id captured from start_game; needed by some action packets. */
  private runtimeEntityId: bigint | null = null;
  /** Actions that threw once are disabled to avoid repeated errors/log spam. */
  private disabled = new Set<string>();

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
    try {
      this.client.queue("command_request", {
        command,
        origin: { type: "player", uuid: "", request_id: "" },
        internal: false,
        version: 66,
      });
    } catch {
      // Older/newer schema or missing field: many servers also accept commands
      // typed straight into chat, so fall back to that.
      this.chatText(command);
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

  /** Swing the arm to look active (best-effort anti-idle). */
  swing(): void {
    if (this.disabled.has("swing") || this.runtimeEntityId == null) return;
    try {
      this.client.queue("animate", {
        action_id: "swing_arm",
        runtime_entity_id: this.runtimeEntityId,
      });
    } catch {
      this.disabled.add("swing");
    }
  }

  /** Start or stop sneaking/crouching (best-effort). */
  setSneak(sneaking: boolean): void {
    if (this.disabled.has("sneak") || this.runtimeEntityId == null) return;
    try {
      this.client.queue("player_action", {
        runtime_entity_id: this.runtimeEntityId,
        action: sneaking ? "start_sneak" : "stop_sneak",
        position: { x: 0, y: 0, z: 0 },
        result_position: { x: 0, y: 0, z: 0 },
        face: 0,
      });
    } catch {
      this.disabled.add("sneak");
    }
  }

  /**
   * Nudge the view yaw to register as "moving" on servers that kick for being
   * perfectly still. Best-effort; disabled on first failure. `yaw` in degrees.
   */
  rotate(yaw: number): void {
    if (this.disabled.has("rotate") || this.runtimeEntityId == null) return;
    try {
      this.client.queue("move_player", {
        runtime_id: this.runtimeEntityId,
        position: { x: 0, y: 0, z: 0 },
        pitch: 0,
        yaw,
        head_yaw: yaw,
        mode: "normal",
        on_ground: true,
        ridden_runtime_id: 0,
        tick: 0,
      });
    } catch {
      this.disabled.add("rotate");
    }
  }

  /**
   * Attempt an inventory move/drop via the modern ItemStackRequest flow. The
   * request format is complex and highly version-dependent; on Bedrock this is
   * best-effort and unverified against a live server. Returns false (and warns)
   * when the action isn't supported by the negotiated protocol schema.
   */
  itemStackRequest(actions: object[]): boolean {
    if (this.disabled.has("item_stack_request")) return false;
    try {
      this.client.queue("item_stack_request", {
        requests: [{ request_id: this.nextRequestId(), actions, custom_names: [], cause: "" }],
      });
      return true;
    } catch {
      this.disabled.add("item_stack_request");
      warn("Inventory item actions are not supported for this Bedrock server/version.");
      return false;
    }
  }

  private reqId = 0;
  private nextRequestId(): number {
    // ItemStackRequest ids are conventionally negative and decreasing.
    this.reqId -= 1;
    return this.reqId;
  }
}
