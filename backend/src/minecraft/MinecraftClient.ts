import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { ClientRuntimeConfig, ClientStatus, ClientStatusSnapshot, ConsoleEvent, ConsoleEventType, MsaSignInPrompt } from "./types.js";
import { accountLogger } from "../logging/logger.js";
import { config as appConfig } from "../config/config.js";
import type { Logger } from "pino";

// Fixed-interval reconnect: exactly 30 seconds per retry (no exponential backoff).
const RECONNECT_DELAY_MS = 30_000;
const RECONNECT_JITTER_MS = 2_000;

// Azalea bot subprocess doesn't need inactivity watchdog (it reports
// disconnects directly), but we keep a safety timeout in case the subprocess
// itself hangs after being spawned.
const SUBPROCESS_HANG_TIMEOUT_MS = 5 * 60_000; // 5 minutes max for a single attempt

/**
 * Wraps the Azalea Rust bot subprocess and exposes a state machine plus
 * console/chat event streaming. One instance == one Minecraft account.
 */
export class MinecraftClient extends EventEmitter {
  private subprocess: ChildProcess | null = null;
  private status: ClientStatus = "OFFLINE";
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private hangTimer: NodeJS.Timeout | null = null;
  private manuallyStopped = false;
  private connectedSince: Date | null = null;
  private lastError: string | undefined;
  private msaSignIn: MsaSignInPrompt | undefined;
  private readonly log: Logger;

  private botName: string = "Unknown";
  private health: number = 20;
  private food: number = 20;

  constructor(private config: ClientRuntimeConfig) {
    super();
    this.log = accountLogger(config.id, config.name);
  }

  updateConfig(config: ClientRuntimeConfig): void {
    this.config = config;
    // If the bot is online, send a Configure command to update behavior settings live.
    if (this.subprocess && this.status === "ONLINE") {
      const cmd = {
        type: "configure",
        afk_enabled: config.afkEnabled,
        movement_enabled: config.movementEnabled,
        afk_interval_seconds: config.afkIntervalSeconds,
        auto_command_enabled: config.autoCommandEnabled,
        auto_command_text: config.autoCommandText,
        auto_command_interval_minutes: config.autoCommandIntervalMinutes,
      };
      this.subprocess.stdin?.write(JSON.stringify(cmd) + "\n");
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
    if (this.status !== "OFFLINE") return;
    this.manuallyStopped = false;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.attemptConnect();
  }

  disconnect(): void {
    this.manuallyStopped = true;
    this.clearReconnectTimer();
    this.teardownSubprocess("Manual disconnect requested");
  }

  restart(): void {
    this.manuallyStopped = false;
    this.clearReconnectTimer();
    this.teardownSubprocess("Restart requested");
    this.attemptConnect();
  }

  sendCommand(command: string): boolean {
    if (this.status !== "ONLINE" || !this.subprocess) {
      this.emitConsole("ERROR", "Bot is not online, cannot send command");
      return false;
    }
    const cmd = { type: "chat", text: command };
    this.subprocess.stdin?.write(JSON.stringify(cmd) + "\n");
    return true;
  }

  sendChat(message: string): void {
    this.sendCommand(message);
  }

  private attemptConnect(): void {
    this.reconnectAttempt++;
    this.setStatus(this.reconnectAttempt > 1 ? "RECONNECTING" : "CONNECTING");

    this.log.info(
      `Connection attempt ${this.reconnectAttempt} to ${this.config.serverHost}:${this.config.serverPort}`
    );

    this.lastError = undefined;

    // Find the azalea-bot binary (built during docker build, or in development at rust-bot/target/debug)
    const botBinaryPath = this.findBotBinary();
    if (!botBinaryPath) {
      const err = "azalea-bot binary not found";
      this.log.error(err);
      this.handleConnectionFailure(err);
      return;
    }

    try {
      this.subprocess = spawn(botBinaryPath, [], { stdio: ["pipe", "pipe", "pipe"] });

      // Parse NDJSON from stdout
      const rl = readline.createInterface({
        input: this.subprocess.stdout!,
        crlfDelay: Infinity,
      });

      rl.on("line", (line) => {
        try {
          const event = JSON.parse(line);
          this.handleRustBotEvent(event);
        } catch (err) {
          this.log.warn({ err, line }, "Failed to parse bot event");
        }
      });

      // Log stderr
      this.subprocess.stderr?.on("data", (data) => {
        this.log.debug({ data: data.toString() }, "Bot stderr");
      });

      // Subprocess exit = connection ended
      this.subprocess.on("exit", (code, signal) => {
        this.log.info({ code, signal }, "Bot subprocess exited");
        if (!this.manuallyStopped) {
          this.handleConnectionFailure(`Subprocess exited with code ${code}`);
        } else {
          this.teardownSubprocess("Subprocess exited (after manual stop)");
        }
      });

      this.subprocess.on("error", (err) => {
        this.log.error(err, "Bot subprocess error");
        this.handleConnectionFailure(err.message);
      });

      // Send initial config
      const cacheDir = path.join(appConfig.dataDir, "bot-cache", this.config.id);
      const minecraftVersion = this.config.minecraftVersion || "";

      const config = {
        host: this.config.serverHost,
        port: this.config.serverPort,
        auth_type: this.config.authType === "MICROSOFT" ? "microsoft" : "offline",
        username: this.config.name,
        email: this.config.credentialsSecret,
        cache_dir: cacheDir,
        afk_enabled: this.config.afkEnabled,
        movement_enabled: this.config.movementEnabled,
        afk_interval_seconds: this.config.afkIntervalSeconds,
        auto_command_enabled: this.config.autoCommandEnabled,
        auto_command_text: this.config.autoCommandText,
        auto_command_interval_minutes: this.config.autoCommandIntervalMinutes,
      };

      this.subprocess.stdin!.write(JSON.stringify(config) + "\n");

      // Safety timeout: if subprocess hasn't reached ONLINE or failed after this long, kill it.
      this.hangTimer = setTimeout(() => {
        if (this.status === "CONNECTING" || this.status === "RECONNECTING") {
          this.log.warn("Bot subprocess hang timeout, killing process");
          this.handleConnectionFailure("Connection timed out (subprocess hang)");
        }
      }, SUBPROCESS_HANG_TIMEOUT_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err }, `Failed to spawn bot subprocess: ${message}`);
      this.handleConnectionFailure(message);
    }
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
        const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
        this.msaSignIn = {
          verificationUri: verification_uri,
          userCode: user_code,
          message: `Visit ${verification_uri} and enter code ${user_code}`,
          expiresAt,
        };
        this.emitConsole("SYSTEM", `MSA Sign-in required: ${verification_uri} (code: ${user_code})`);
        break;
      }

      case "login": {
        this.log.info("Bot received login packet");
        this.emitConsole("SYSTEM", "Logged in to server (login packet received)");
        break;
      }

      case "spawn": {
        this.clearHangTimer();
        this.setStatus("ONLINE");
        this.connectedSince = new Date();
        this.msaSignIn = undefined;
        this.lastError = undefined;
        this.log.info("Bot spawned successfully");
        this.emitConsole("SYSTEM", "Spawned into the world");
        break;
      }

      case "chat": {
        const { sender, message } = event as { sender: string | null; message: string };
        if (sender) {
          this.emitConsole("CHAT", `[${sender}]: ${message}`);
        } else {
          this.emitConsole("SERVER_MESSAGE", message);
        }
        break;
      }

      case "disconnect": {
        const reason = (event as { reason?: string }).reason;
        this.log.info({ reason }, "Bot disconnected");
        this.emitConsole("SYSTEM", `Disconnected: ${reason || "unknown reason"}`);
        if (!this.manuallyStopped) {
          this.handleConnectionFailure(reason || "Disconnected");
        } else {
          this.teardownSubprocess("Disconnected after manual stop");
        }
        break;
      }

      case "connection_failed": {
        const error = (event as { error: string }).error;
        this.log.warn({ error }, "Connection failed");
        this.emitConsole("ERROR", `Connection failed: ${error}`);
        this.handleConnectionFailure(error);
        break;
      }

      case "warning": {
        const message = (event as { message: string }).message;
        this.log.warn(message);
        this.emitConsole("WARNING", message);
        break;
      }

      case "fatal_error": {
        const error = (event as { error: string }).error;
        this.log.error({ error }, "Fatal bot error");
        this.emitConsole("ERROR", `Fatal error: ${error}`);
        this.handleConnectionFailure(error);
        break;
      }

      case "behavior_log": {
        const message = (event as { message: string }).message;
        this.log.debug(message);
        this.emitConsole("SYSTEM", `[Behavior] ${message}`);
        break;
      }

      default:
        this.log.debug({ type }, "Unknown bot event type");
    }
  }

  private handleConnectionFailure(reason: string): void {
    this.lastError = reason;
    this.clearHangTimer();
    this.teardownSubprocess(`Connection failed: ${reason}`);

    if (this.manuallyStopped) {
      this.setStatus("OFFLINE");
      return;
    }

    // Schedule a reconnect
    const delay = RECONNECT_DELAY_MS + Math.random() * RECONNECT_JITTER_MS;
    this.log.info(
      { delay, attempt: this.reconnectAttempt },
      `Reconnecting in ${Math.round(delay / 1000)}s`
    );
    this.emitConsole("SYSTEM", `Will reconnect in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt})...`);

    this.reconnectTimer = setTimeout(() => {
      this.attemptConnect();
    }, delay);
  }

  private teardownSubprocess(reason: string): void {
    if (this.subprocess) {
      this.log.debug(reason);

      // Try graceful disconnect first
      if (this.subprocess.stdin && !this.subprocess.stdin.destroyed) {
        try {
          this.subprocess.stdin.write(JSON.stringify({ type: "disconnect" }) + "\n");
        } catch (err) {
          this.log.debug("Failed to write disconnect command");
        }
      }

      // Give subprocess a moment to exit gracefully
      setTimeout(() => {
        if (this.subprocess && !this.subprocess.killed) {
          this.subprocess.kill("SIGTERM");
          setTimeout(() => {
            if (this.subprocess && !this.subprocess.killed) {
              this.subprocess.kill("SIGKILL");
            }
          }, 1000);
        }
      }, 500);

      this.subprocess = null;
    }

    this.connectedSince = null;
    this.msaSignIn = undefined;
  }

  private setStatus(newStatus: ClientStatus): void {
    if (this.status !== newStatus) {
      this.log.debug(`Status: ${this.status} -> ${newStatus}`);
      this.status = newStatus;
      this.emit("statusChanged", newStatus);
    }
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

  private emitConsole(type: ConsoleEventType, message: string): void {
    this.emit("console", {
      minecraftAccountId: this.config.id,
      type,
      message,
      timestamp: new Date().toISOString(),
    } as ConsoleEvent);
  }

  private findBotBinary(): string | null {
    // In Docker, the binary is at /app/azalea-bot (copied in Dockerfile)
    if (existsSync("/app/azalea-bot")) return "/app/azalea-bot";

    // In development, the binary is at rust-bot/target/debug/azalea-bot relative to cwd
    const devPath = path.join(process.cwd(), "rust-bot", "target", "debug", "azalea-bot");
    if (existsSync(devPath)) return devPath;

    // On Windows dev
    const devPathExe = devPath + ".exe";
    if (existsSync(devPathExe)) return devPathExe;

    return null;
  }
}
