import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type {
  ClientRuntimeConfig,
  ClientStatus,
  ClientStatusSnapshot,
  ConsoleEvent,
  ConsoleEventType,
  MsaSignInPrompt,
  ProfileEvent,
} from "./types.js";
import { accountLogger } from "../logging/logger.js";
import { config as appConfig } from "../config/config.js";
import type { Logger } from "pino";

// Fixed-interval reconnect: ~30 seconds per retry (no exponential backoff), as
// requested. A little jitter avoids thundering-herd reconnects when many bots
// drop at once.
const RECONNECT_DELAY_MS = 30_000;
const RECONNECT_JITTER_MS = 2_000;

// Safety net: if a spawned bot never reaches ONLINE or reports a failure within
// this window, we treat the attempt as hung and recycle it.
const SUBPROCESS_HANG_TIMEOUT_MS = 5 * 60_000;
/// If an ONLINE bot emits nothing (not even a heartbeat, which fires every ~20s)
/// for this long, treat it as hung and recycle it. Recovers frozen bots that
/// previously required a manual restart.
const SUBPROCESS_ONLINE_SILENCE_MS = 90_000;
/// How often the online-hang watchdog checks for subprocess silence.
const ONLINE_WATCHDOG_INTERVAL_MS = 15_000;

/**
 * Wraps the Azalea Rust bot subprocess (one per Minecraft account) and exposes
 * a small state machine plus console/status/profile event streams.
 *
 * The Rust process speaks NDJSON over stdio: we send a config line then command
 * lines, and read one JSON event per stdout line. Node owns the reconnect
 * policy — the Rust bot simply exits when a connection ends, and we respawn it.
 *
 * Emitted events:
 *   - "status"  (ClientStatusSnapshot)  status/detail changed
 *   - "console" (ConsoleEvent)          a console line to display/persist
 *   - "profile" (ProfileEvent)          resolved Minecraft username/uuid
 */
export class MinecraftClient extends EventEmitter {
  private subprocess: ChildProcess | null = null;
  private status: ClientStatus = "OFFLINE";
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private hangTimer: NodeJS.Timeout | null = null;
  private onlineWatchdog: NodeJS.Timeout | null = null;
  /** Epoch ms of the last line received from the bot subprocess. */
  private lastActivityAt = 0;
  private manuallyStopped = false;
  /** Guards against a single connection attempt being "ended" more than once. */
  private connectionEnded = false;
  private connectedSince: Date | null = null;
  private lastError: string | undefined;
  private msaSignIn: MsaSignInPrompt | undefined;
  private readonly log: Logger;

  private health = 20;
  private food = 20;

  constructor(private config: ClientRuntimeConfig) {
    super();
    this.log = accountLogger(config.id, config.name);
  }

  updateConfig(config: ClientRuntimeConfig): void {
    this.config = config;
    // Push behavior settings to a running bot so changes take effect live.
    if (this.subprocess && this.status === "ONLINE") {
      this.sendToBot({
        type: "configure",
        afk_enabled: config.afkEnabled,
        movement_enabled: config.movementEnabled,
        afk_interval_seconds: config.afkIntervalSeconds,
        auto_command_enabled: config.autoCommandEnabled,
        auto_command_text: config.autoCommandText,
        auto_command_interval_minutes: config.autoCommandIntervalMinutes,
        tpauto_enabled: config.tpAutoEnabled,
        autosell_enabled: config.autoSellEnabled,
        autosell_interval_seconds: config.autoSellIntervalSeconds,
        autosell_command: config.autoSellCommand,
      });
    }
  }

  getStatus(): ClientStatusSnapshot {
    return {
      id: this.config.id,
      name: this.config.name,
      status: this.status,
      serverHost: this.config.serverHost,
      serverPort: this.config.serverPort,
      health: this.health,
      food: this.food,
      connectedSince: this.connectedSince?.toISOString(),
      lastError: this.lastError,
      reconnectAttempt: this.reconnectAttempt,
      msaSignIn: this.msaSignIn,
    };
  }

  connect(): void {
    if (this.status !== "OFFLINE" && this.status !== "ERROR") return;
    this.manuallyStopped = false;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.attemptConnect();
  }

  disconnect(): void {
    this.manuallyStopped = true;
    this.clearReconnectTimer();
    this.clearHangTimer();
    this.teardownSubprocess("Manual disconnect requested");
    this.setStatus("OFFLINE");
  }

  restart(): void {
    this.manuallyStopped = false;
    this.clearReconnectTimer();
    this.clearHangTimer();
    this.teardownSubprocess("Restart requested");
    this.reconnectAttempt = 0;
    this.attemptConnect();
  }

  sendCommand(command: string): boolean {
    if (this.status !== "ONLINE" || !this.subprocess) {
      this.emitConsole("ERROR", "Bot is not online, cannot send command");
      return false;
    }
    this.sendToBot({ type: "chat", text: command });
    return true;
  }

  sendChat(message: string): void {
    this.sendCommand(message);
  }

  private attemptConnect(): void {
    this.connectionEnded = false;
    this.reconnectAttempt++;
    this.setStatus(this.reconnectAttempt > 1 ? "RECONNECTING" : "CONNECTING");
    this.lastError = undefined;

    this.log.info(
      `Connection attempt ${this.reconnectAttempt} to ${this.config.serverHost}:${this.config.serverPort}`,
    );

    const botBinaryPath = this.findBotBinary();
    if (!botBinaryPath) {
      const err = "azalea-bot binary not found";
      this.log.error(err);
      this.emitConsole("ERROR", err);
      this.handleConnectionFailure(err);
      return;
    }

    let child: ChildProcess;
    try {
      // RUST_LOG=error keeps Azalea's own logging off stdout so it can't
      // interfere with the NDJSON protocol (any stray line is ignored anyway).
      child = spawn(botBinaryPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, RUST_LOG: "error" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err }, `Failed to spawn bot subprocess: ${message}`);
      this.handleConnectionFailure(message);
      return;
    }

    this.subprocess = child;
    this.lastActivityAt = Date.now();
    this.startOnlineWatchdog();

    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (child !== this.subprocess) return; // ignore a superseded process
      const trimmed = line.trim();
      if (!trimmed) return;
      this.lastActivityAt = Date.now();
      try {
        this.handleRustBotEvent(JSON.parse(trimmed));
      } catch (err) {
        // Non-JSON line (e.g. a stray log): safe to ignore.
        this.log.debug({ err, line: trimmed }, "Ignoring non-JSON bot output");
      }
    });

    child.stderr?.on("data", (data) => {
      if (child !== this.subprocess) return;
      this.log.debug({ data: data.toString() }, "Bot stderr");
    });

    // Use "close" (not "exit"): it fires only after the process has ended AND
    // its stdout has been fully drained, so any final connection_failed /
    // disconnect line (carrying the human-readable reason) has already been
    // handled by the "line" listener above — which nulls out this.subprocess,
    // making the guard below skip this handler. "exit" alone races the stdout
    // pipe and would clobber the reason.
    child.on("close", (code, signal) => {
      if (child !== this.subprocess) return;
      this.log.info({ code, signal }, "Bot subprocess closed");
      if (this.manuallyStopped) {
        this.teardownSubprocess("Subprocess closed after manual stop");
      } else {
        this.handleConnectionFailure(
          code && code !== 0 ? `Bot exited with code ${code}` : "Connection ended",
        );
      }
    });

    child.on("error", (err) => {
      if (child !== this.subprocess) return;
      this.log.error(err, "Bot subprocess error");
      this.handleConnectionFailure(err.message);
    });

    // Send the initial config line.
    const cacheDir = path.join(appConfig.dataDir, "bot-cache", this.config.id);
    this.sendToBot({
      host: this.config.serverHost,
      port: this.config.serverPort,
      auth_type: this.config.authType === "MICROSOFT" ? "microsoft" : "offline",
      username: this.config.name,
      email: this.config.credentialsSecret,
      password: this.config.credentialsPassword,
      cache_dir: cacheDir,
      afk_enabled: this.config.afkEnabled,
      movement_enabled: this.config.movementEnabled,
      afk_interval_seconds: this.config.afkIntervalSeconds,
      auto_command_enabled: this.config.autoCommandEnabled,
      auto_command_text: this.config.autoCommandText,
      auto_command_interval_minutes: this.config.autoCommandIntervalMinutes,
      tpauto_enabled: this.config.tpAutoEnabled,
      autosell_enabled: this.config.autoSellEnabled,
      autosell_interval_seconds: this.config.autoSellIntervalSeconds,
      autosell_command: this.config.autoSellCommand,
    });

    this.hangTimer = setTimeout(() => {
      if (this.status === "CONNECTING" || this.status === "RECONNECTING") {
        this.log.warn("Bot subprocess hang timeout, recycling");
        this.handleConnectionFailure("Connection timed out");
      }
    }, SUBPROCESS_HANG_TIMEOUT_MS);
  }

  private handleRustBotEvent(event: Record<string, unknown>): void {
    const type = event.type as string;

    switch (type) {
      case "msa_code": {
        const { verification_uri, user_code, expires_in } = event as {
          verification_uri: string;
          user_code: string;
          expires_in: number;
        };
        this.msaSignIn = {
          verificationUri: verification_uri,
          userCode: user_code,
          message: `Visit ${verification_uri} and enter code ${user_code}`,
          expiresAt: new Date(Date.now() + expires_in * 1000).toISOString(),
        };
        this.emitConsole("SYSTEM", `Microsoft sign-in required: ${verification_uri} (code: ${user_code})`);
        this.emitStatus();
        break;
      }

      case "profile": {
        const { username, uuid } = event as { username: string; uuid: string };
        this.log.info({ username, uuid }, "Resolved Minecraft profile");
        this.emitConsole("SYSTEM", `Authenticated as ${username}`);
        this.emit("profile", { minecraftAccountId: this.config.id, username, uuid } as ProfileEvent);
        break;
      }

      case "login":
        this.emitConsole("SYSTEM", "Logged in, joining world...");
        break;

      case "spawn":
        this.clearHangTimer();
        this.connectedSince = new Date();
        this.msaSignIn = undefined;
        this.lastError = undefined;
        this.reconnectAttempt = 0;
        this.setStatus("ONLINE");
        this.emitConsole("SYSTEM", "Spawned into the world");
        break;

      case "chat": {
        const { sender, message } = event as { sender: string | null; message: string };
        if (sender) this.emitConsole("CHAT", `<${sender}> ${message}`);
        else this.emitConsole("SERVER_MESSAGE", message);
        break;
      }

      case "behavior_log":
        this.emitConsole("SYSTEM", String((event as { message: string }).message));
        break;

      case "health": {
        const { health, food } = event as { health: number; food: number };
        this.health = health;
        this.food = food;
        this.emitStatus();
        break;
      }

      case "heartbeat":
        // Liveness only; lastActivityAt is already refreshed for every line.
        break;

      case "warning":
        this.emitConsole("WARNING", String((event as { message: string }).message));
        break;

      case "disconnect": {
        const reason = (event as { reason?: string | null }).reason ?? "unknown reason";
        this.emitConsole("SYSTEM", `Disconnected: ${reason}`);
        // The subprocess will exit right after; the exit handler drives the
        // reconnect. We record the reason for display.
        this.lastError = reason;
        break;
      }

      case "connection_failed": {
        const error = String((event as { error: string }).error);
        this.emitConsole("ERROR", `Connection failed: ${error}`);
        this.handleConnectionFailure(error);
        break;
      }

      case "fatal_error": {
        const error = String((event as { error: string }).error);
        this.emitConsole("ERROR", `Fatal error: ${error}`);
        this.handleConnectionFailure(error);
        break;
      }

      default:
        this.log.debug({ type }, "Unknown bot event type");
    }
  }

  private handleConnectionFailure(reason: string): void {
    if (this.connectionEnded) return;
    this.connectionEnded = true;
    this.lastError = reason;
    this.clearHangTimer();
    this.teardownSubprocess(`Connection ended: ${reason}`);

    if (this.manuallyStopped) {
      this.setStatus("OFFLINE");
      return;
    }

    if (!this.config.autoReconnect) {
      this.emitConsole("WARNING", "Auto-reconnect is disabled; staying offline.");
      this.setStatus("ERROR");
      return;
    }

    const delay = RECONNECT_DELAY_MS + Math.random() * RECONNECT_JITTER_MS;
    const seconds = Math.round(delay / 1000);
    this.setStatus("RECONNECTING");
    this.emitConsole("SYSTEM", `Reconnecting in ${seconds}s (attempt ${this.reconnectAttempt + 1})...`);
    this.log.info({ delay, attempt: this.reconnectAttempt }, `Reconnecting in ${seconds}s`);

    this.reconnectTimer = setTimeout(() => this.attemptConnect(), delay);
  }

  private teardownSubprocess(reason: string): void {
    this.clearOnlineWatchdog();
    const child = this.subprocess;
    this.subprocess = null;
    this.connectedSince = null;
    this.msaSignIn = undefined;
    if (!child) return;

    this.log.debug(reason);
    try {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(JSON.stringify({ type: "disconnect" }) + "\n");
      }
    } catch {
      /* stdin may already be gone */
    }

    // Give the bot a moment to exit gracefully, then force it.
    setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1500);
    }, 500);
  }

  private sendToBot(payload: Record<string, unknown>): void {
    try {
      this.subprocess?.stdin?.write(JSON.stringify(payload) + "\n");
    } catch (err) {
      this.log.debug({ err }, "Failed to write to bot stdin");
    }
  }

  private setStatus(newStatus: ClientStatus): void {
    if (this.status === newStatus) return;
    this.log.debug(`Status: ${this.status} -> ${newStatus}`);
    this.status = newStatus;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit("status", this.getStatus());
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHangTimer(): void {
    if (this.hangTimer) {
      clearTimeout(this.hangTimer);
      this.hangTimer = null;
    }
  }

  private startOnlineWatchdog(): void {
    this.clearOnlineWatchdog();
    this.onlineWatchdog = setInterval(() => {
      if (this.status !== "ONLINE") return;
      const silentFor = Date.now() - this.lastActivityAt;
      if (silentFor > SUBPROCESS_ONLINE_SILENCE_MS) {
        this.log.warn({ silentFor }, "Bot subprocess silent while online, recycling");
        this.emitConsole("WARNING", "Bot appears frozen (no heartbeat); reconnecting…");
        this.handleConnectionFailure("Bot froze (no heartbeat)");
      }
    }, ONLINE_WATCHDOG_INTERVAL_MS);
  }

  private clearOnlineWatchdog(): void {
    if (this.onlineWatchdog) {
      clearInterval(this.onlineWatchdog);
      this.onlineWatchdog = null;
    }
  }

  private emitConsole(type: ConsoleEventType, message: string): void {
    this.emit("console", {
      minecraftAccountId: this.config.id,
      type,
      message,
      timestamp: new Date().toISOString(),
    } as ConsoleEvent);
  }

  /** Locate the compiled azalea-bot binary (Docker image or local dev build). */
  private findBotBinary(): string | null {
    const candidates = [
      "/app/azalea-bot",
      path.join(process.cwd(), "rust-bot", "target", "release", "azalea-bot"),
      path.join(process.cwd(), "rust-bot", "target", "debug", "azalea-bot"),
      path.join(process.cwd(), "..", "rust-bot", "target", "release", "azalea-bot"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
      if (existsSync(candidate + ".exe")) return candidate + ".exe";
    }
    return null;
  }
}
