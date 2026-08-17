import { EventEmitter } from "node:events";
import path from "node:path";
import mineflayer, { type Bot } from "mineflayer";
import { BehaviorManager } from "./behaviors/BehaviorManager.js";
import type { ClientRuntimeConfig, ClientStatus, ClientStatusSnapshot, ConsoleEvent, MsaSignInPrompt } from "./types.js";
import { accountLogger } from "../logging/logger.js";
import { config as appConfig } from "../config/config.js";
import type { Logger } from "pino";

// Fixed-interval reconnect: every failed/dropped connection retries after
// exactly this delay (± a little jitter to avoid a thundering herd if many
// bots drop at once). Deliberately NOT exponential — for a 24/7 AFK bot a
// steady, predictable retry cadence is preferred over ever-longer waits.
const RECONNECT_DELAY_MS = 30_000;
const RECONNECT_JITTER_MS = 2_000;

/**
 * Wraps a single Mineflayer bot connection and exposes a small, explicit
 * state machine (OFFLINE -> CONNECTING -> ONLINE -> DISCONNECTING/RECONNECTING/ERROR)
 * plus console/chat event streaming. One instance == one Minecraft account.
 *
 * Errors from this bot are always caught locally: a crash/error here must
 * never take down the process or affect other MinecraftClient instances.
 */
export class MinecraftClient extends EventEmitter {
  private bot: Bot | null = null;
  private status: ClientStatus = "OFFLINE";
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private manuallyStopped = false;
  private connectedSince: Date | null = null;
  private lastError: string | undefined;
  private msaSignIn: MsaSignInPrompt | undefined;
  private readonly behaviorManager: BehaviorManager;
  private readonly log: Logger;

  constructor(private config: ClientRuntimeConfig) {
    super();
    this.log = accountLogger(config.id, config.name);
    this.behaviorManager = new BehaviorManager(
      {
        afkEnabled: config.afkEnabled,
        movementEnabled: config.movementEnabled,
        afkIntervalSeconds: config.afkIntervalSeconds,
        autoCommandEnabled: config.autoCommandEnabled,
        autoCommandText: config.autoCommandText,
        autoCommandIntervalMinutes: config.autoCommandIntervalMinutes,
      },
      (message) => this.emitConsole("SYSTEM", message),
    );
  }

  updateConfig(config: ClientRuntimeConfig): void {
    this.config = config;
    this.behaviorManager.updateConfig({
      afkEnabled: config.afkEnabled,
      movementEnabled: config.movementEnabled,
      afkIntervalSeconds: config.afkIntervalSeconds,
      autoCommandEnabled: config.autoCommandEnabled,
      autoCommandText: config.autoCommandText,
      autoCommandIntervalMinutes: config.autoCommandIntervalMinutes,
    });
  }

  getStatus(): ClientStatusSnapshot {
    return {
      id: this.config.id,
      name: this.config.name,
      status: this.status,
      serverHost: this.config.serverHost,
      serverPort: this.config.serverPort,
      health: this.bot?.health,
      food: this.bot?.food,
      position: this.bot?.entity?.position
        ? { x: this.bot.entity.position.x, y: this.bot.entity.position.y, z: this.bot.entity.position.z }
        : undefined,
      lastError: this.lastError,
      reconnectAttempt: this.reconnectAttempt,
      connectedSince: this.connectedSince?.toISOString(),
      msaSignIn: this.msaSignIn,
    };
  }

  connect(): void {
    this.manuallyStopped = false;
    if (this.status === "ONLINE" || this.status === "CONNECTING") return;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.beginConnection();
  }

  disconnect(): void {
    this.manuallyStopped = true;
    this.clearReconnectTimer();
    this.setStatus("DISCONNECTING");
    this.teardownBot("Manual disconnect requested");
    this.msaSignIn = undefined;
    this.setStatus("OFFLINE");
  }

  async restart(): Promise<void> {
    this.emitConsole("SYSTEM", "Restarting client...");
    this.manuallyStopped = true;
    this.clearReconnectTimer();
    this.teardownBot("Restart requested");
    await new Promise((resolve) => setTimeout(resolve, 500));
    this.connect();
  }

  sendCommand(command: string): boolean {
    const normalized = command.startsWith("/") ? command : `/${command}`;
    return this.sendRaw(normalized, "USER_COMMAND", `> ${normalized}`);
  }

  sendChat(message: string): boolean {
    return this.sendRaw(message, "USER_COMMAND", `> ${message}`);
  }

  private sendRaw(text: string, eventType: ConsoleEvent["type"], displayMessage: string): boolean {
    if (!this.bot || this.status !== "ONLINE") {
      this.emitConsole("WARNING", "Cannot send: client is not online");
      return false;
    }
    try {
      this.bot.chat(text);
      this.emitConsole(eventType, displayMessage);
      return true;
    } catch (err) {
      this.emitConsole("ERROR", `Failed to send: ${(err as Error).message}`);
      return false;
    }
  }

  private beginConnection(): void {
    this.setStatus(this.reconnectAttempt > 0 ? "RECONNECTING" : "CONNECTING");
    this.emitConsole("SYSTEM", `Connecting to ${this.config.serverHost}:${this.config.serverPort}...`);
    this.msaSignIn = undefined;

    try {
      // NOTE: minecraft-protocol's TypeScript types incorrectly declare
      // `onMsaCode`'s payload with snake_case fields, but the real runtime
      // object from @azure/msal-node uses camelCase (verified against the
      // installed library source). We type our callback with the actual
      // runtime shape and cast the options object to bypass the incorrect
      // ambient types rather than the (wrong) declared type.
      const botOptions = {
        host: this.config.serverHost,
        port: this.config.serverPort,
        username: this.config.authType === "OFFLINE" ? this.config.name : this.config.credentialsSecret ?? this.config.name,
        version: this.config.minecraftVersion || undefined,
        auth: this.config.authType === "MICROSOFT" ? "microsoft" : "offline",
        // Persist the Microsoft auth token cache per-account inside the data
        // dir (Docker volume), so re-authentication is only needed once.
        profilesFolder:
          this.config.authType === "MICROSOFT"
            ? path.join(appConfig.dataDir, "mc-auth-cache", this.config.id)
            : undefined,
        onMsaCode: (data: { verificationUri: string; userCode: string; message: string; expiresIn: number }) => {
          this.msaSignIn = {
            verificationUri: data.verificationUri,
            userCode: data.userCode,
            message: data.message,
            expiresAt: new Date(Date.now() + data.expiresIn * 1000).toISOString(),
          };
          this.emitConsole(
            "SYSTEM",
            `Microsoft sign-in required: open ${data.verificationUri} and enter code ${data.userCode}`,
          );
          this.emit("status", this.getStatus());
        },
      };
      const bot = mineflayer.createBot(botOptions as unknown as Parameters<typeof mineflayer.createBot>[0]);
      this.attachBotHandlers(bot);
      this.bot = bot;
    } catch (err) {
      this.handleFatalError(err as Error);
    }
  }

  private attachBotHandlers(bot: Bot): void {
    bot.once("spawn", () => {
      this.reconnectAttempt = 0;
      this.connectedSince = new Date();
      this.msaSignIn = undefined;
      this.setStatus("ONLINE");
      this.emitConsole("SYSTEM", "Spawned into world");
      this.behaviorManager.start(bot);
    });

    bot.on("chat", (username: string, message: string) => {
      if (username === bot.username) return;
      this.emitConsole("CHAT", `${username}: ${message}`);
    });

    bot.on("message", (jsonMsg, position) => {
      if (position === "chat") return; // already handled via the 'chat' event above
      const text = jsonMsg.toString();
      if (text.trim().length === 0) return;
      this.emitConsole("SERVER_MESSAGE", text);
    });

    bot.on("kicked", (reason) => {
      this.emitConsole("WARNING", `Kicked from server: ${this.stringifyReason(reason)}`);
      this.log.warn({ reason }, "Bot kicked");
    });

    bot.on("error", (err: Error) => {
      this.log.error({ err }, "Mineflayer bot error");
      this.emitConsole("ERROR", `Connection error: ${err.message}`);
      this.lastError = err.message;
    });

    bot.on("end", (reason?: string) => {
      this.behaviorManager.stop();
      this.connectedSince = null;
      this.bot = null;

      if (this.manuallyStopped) {
        this.emitConsole("SYSTEM", "Disconnected");
        this.setStatus("OFFLINE");
        return;
      }

      this.emitConsole("WARNING", `Disconnected${reason ? `: ${reason}` : ""}`);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.config.autoReconnect) {
      this.setStatus("OFFLINE");
      return;
    }

    this.reconnectAttempt += 1;
    const delay = RECONNECT_DELAY_MS + Math.floor(Math.random() * RECONNECT_JITTER_MS);

    this.setStatus("RECONNECTING");
    this.emitConsole("SYSTEM", `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt})...`);

    this.reconnectTimer = setTimeout(() => {
      this.beginConnection();
    }, delay);
  }

  private handleFatalError(err: Error): void {
    this.log.error({ err }, "Failed to create bot");
    this.lastError = err.message;
    this.emitConsole("ERROR", `Failed to connect: ${err.message}`);
    this.scheduleReconnect();
  }

  private teardownBot(reason: string): void {
    this.clearReconnectTimer();
    this.behaviorManager.stop();
    if (this.bot) {
      try {
        this.bot.quit(reason);
      } catch {
        /* already disconnected */
      }
      this.bot = null;
    }
    this.connectedSince = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: ClientStatus): void {
    this.status = status;
    this.emit("status", this.getStatus());
  }

  private emitConsole(type: ConsoleEvent["type"], message: string): void {
    const event: ConsoleEvent = {
      minecraftAccountId: this.config.id,
      type,
      message,
      timestamp: new Date().toISOString(),
    };
    this.log.info({ type, message }, "console event");
    this.emit("console", event);
  }

  private stringifyReason(reason: unknown): string {
    if (typeof reason === "string") return reason;
    try {
      return JSON.stringify(reason);
    } catch {
      return String(reason);
    }
  }
}
