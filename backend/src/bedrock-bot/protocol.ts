//! NDJSON protocol shared between this Bedrock bot process and the Node.js
//! backend. It is intentionally byte-for-byte compatible with the Azalea Rust
//! bot's protocol (see backend/rust-bot/src/protocol.rs) so the entire rest of
//! the app — MinecraftClient.ts, ClientManager, WebSocket, dashboard — talks to
//! Java and Bedrock bots through the exact same event/command contract.
//!
//!   * The FIRST stdin line is a `Config` JSON object.
//!   * Every SUBSEQUENT stdin line is a `Command` JSON object.
//!   * Every stdout line is an `OutEvent` JSON object.
//!
//! The Node backend owns the reconnect policy: this process simply exits when
//! the connection ends or fails, and Node respawns it.

/** The first line sent on stdin when the process starts. */
export interface Config {
  host: string;
  port: number;
  /** "offline" or "microsoft". */
  auth_type: string;
  /** Offline-mode display name (also used as a fallback display name). */
  username: string;
  /** Target Bedrock version, empty string means "auto-detect". */
  version?: string;
  /** Microsoft account email; required when auth_type === "microsoft". */
  email?: string | null;
  /** Microsoft account password (unused by Bedrock device-code flow, kept for parity). */
  password?: string | null;
  /** Directory used to persist the Microsoft auth token cache for this account. */
  cache_dir: string;

  /** When true, continuously sneak/crouch. */
  crouch_enabled?: boolean;
  autosell_enabled?: boolean;
  autosell_interval_seconds?: number;
  autosell_command?: string;
  autosell_pause_after_ms?: number;
  autosell_resume_after_ms?: number;
}

/** Behavior-only subset of Config, re-sent later to update settings live. */
export interface BehaviorConfig {
  crouch_enabled?: boolean;
  autosell_enabled?: boolean;
  autosell_interval_seconds?: number;
  autosell_command?: string;
}

/** Commands received on stdin (one JSON object per line), tagged by `type`. */
export type Command =
  | { type: "chat"; text: string }
  | { type: "background_chat"; text: string }
  | ({ type: "configure" } & BehaviorConfig)
  | { type: "clean_spawner" }
  | { type: "check_crouch" }
  | { type: "pause_autosell"; autosell_pause_after_ms: number; autosell_resume_after_ms: number }
  | { type: "disconnect" };

/** Events emitted on stdout, one JSON object per line, tagged by `type`. */
export type OutEvent =
  | { type: "msa_code"; verification_uri: string; user_code: string; expires_in: number }
  | { type: "profile"; username: string; uuid: string }
  | { type: "login" }
  | { type: "spawn" }
  | { type: "chat"; sender: string | null; message: string }
  | { type: "disconnect"; reason: string | null }
  | { type: "connection_failed"; error: string }
  | { type: "warning"; message: string }
  | { type: "fatal_error"; error: string }
  | { type: "behavior_log"; message: string }
  | { type: "health"; health: number; food: number }
  | { type: "heartbeat" };

/**
 * Serialize and print a single NDJSON event on stdout. `process.stdout.write`
 * is synchronous for pipes on Linux, so ordering with the event loop is
 * preserved and Node receives each event promptly.
 */
export function emit(event: OutEvent): void {
  try {
    process.stdout.write(JSON.stringify(event) + "\n");
  } catch {
    /* stdout may be closed during shutdown */
  }
}
