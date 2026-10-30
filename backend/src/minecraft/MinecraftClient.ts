import { EventEmitter } from "node:events";
import { isSlashCommand, isBlockedAfkCommand, AFK_BLOCK_MESSAGE } from "./slashCommands.js";
import { parseSellEarning } from "./sellEarnings.js";
import {
  parseWorldRestartSeconds, WORLD_RESTART_SELL_LEAD_MS, WORLD_RESTART_SELL_COOLDOWN_MS,
} from "./worldRestart.js";
import { createSoulFireController, type SoulFireController } from "../soulfire/controller.js";
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
import { stopRemoteAccount } from "../soulfire/lifecycle.js";
import { terminateSubprocess } from "../utils/terminateSubprocess.js";

// Fixed, locked retry interval for every account and every attempt.
const RECONNECT_DELAY_MS = 15_000;
const MANUAL_RESTART_DELAY_MS = 5_000;

// Safety net: if a spawned bot never reaches ONLINE or reports a failure within
// this window, we treat the attempt as hung and recycle it.
const SUBPROCESS_HANG_TIMEOUT_MS = 5 * 60_000;
/// Require a heartbeat from the behavior tick itself. Chat and other packets
/// may still arrive even when ticks and queued commands have stopped.
const SUBPROCESS_ONLINE_SILENCE_MS = 45_000;
/// How often the online-hang watchdog checks for subprocess silence.
const ONLINE_WATCHDOG_INTERVAL_MS = 15_000;


/**
 * Strip Minecraft formatting/color codes from a string. Servers send the
 * section sign `§` (U+00A7) followed by a code char (0-9 colours, a-f colours,
 * k-o styles, r reset, plus Bedrock's extra colours g-u). These control codes
 * are meaningless in a plain-text web console and show up as garbage (e.g.
 * `§r§c`), so we remove them from chat/server text. Only `§` is stripped (not
 * the `&` config variant) to avoid eating legitimate text like "Tom & Jerry".
 */
function stripMinecraftFormatting(text: string): string {
  return text.replace(/§[0-9a-u]/gi, "").replace(/§/g, "");
}

/** Match the reported failed-server fallback, including proxy punctuation variants. */
function isServerFallbackMessage(message: string): boolean {
  return /^Verbindung zum vorherigen Server verloren\s*[–—-]\s*du wurdest auf einen anderen Server verschoben[.!]?$/iu
    .test(message.trim().replace(/\s+/g, " "));
}

/** Supervises isolated SoulFire controllers through the existing NDJSON
 * contract. All controllers share Node and a dedicated JVM, avoiding one OS
 * process per account. This class owns reconnection and website events. */
export class MinecraftClient extends EventEmitter {
  private subprocess: SoulFireController | null = null;
  private pendingStop: Promise<void> = Promise.resolve();
  private status: ClientStatus = "OFFLINE";
  private reconnectTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private hangTimer: NodeJS.Timeout | null = null;
  private onlineWatchdog: NodeJS.Timeout | null = null;
  /** Epoch ms of the last confirmed behavior tick heartbeat. */
  private lastHeartbeatAt = 0;
  private manuallyStopped = false;
  /** Guards against a single connection attempt being "ended" more than once. */
  private connectionEnded = false;
  private connectedSince: Date | null = null;
  private lastError: string | undefined;
  private msaSignIn: MsaSignInPrompt | undefined;
  private authenticated = false;
  private readonly log: Logger;

  /** Kept by the supervisor so a subprocess reconnect cannot bypass the pause. */
  private worldRestartAt: number | null = null;
  private restartCrouchTimer: NodeJS.Timeout | null = null;
  private restartCrouchWindowEnd = 0;
  private lastCrouchRestartAt: number | null = null;
  private pendingRestartCrouchCheck = false;
  private periodicCrouchTimer: NodeJS.Timeout | null = null;
  private pendingPeriodicCrouchCheck = false;

  constructor(private config: ClientRuntimeConfig) {
    super();
    this.log = accountLogger(config.id, config.name);
  }

  /** Stops all timers and disconnects; call when the account is removed. */
  dispose(): void {
    if (this.restartCrouchTimer) clearInterval(this.restartCrouchTimer);
    this.restartCrouchTimer = null;
    this.disconnect();
  }

  updateConfig(config: ClientRuntimeConfig): void {
    this.config = config;
    this.syncPeriodicCrouchChecks();
    // Push behavior settings to a running bot so changes take effect live.
    if (this.subprocess && this.status === "ONLINE") {
      this.sendToBot({
        type: "configure",
        crouch_enabled: config.crouchEnabled,
        auto_button: (config.autoButton ?? "OFF").toLowerCase(),
        autosell_enabled: config.autoSellEnabled,
        autosell_interval_seconds: config.autoSellIntervalSeconds,
        autosell_command: config.autoSellCommand,
        spawner_type: config.spawnerType,
        spawner_drop_items: config.spawnerDropItems,
        spawner_sell_items: config.spawnerSellItems,
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
      connectedSince: this.connectedSince?.toISOString(),
      lastError: this.lastError,
      msaSignIn: this.msaSignIn,
      authenticated: this.authenticated,
    };
  }

  connect(): void {
    if (this.status !== "OFFLINE" && this.status !== "ERROR") return;
    if (this.restartTimer) return;
    this.manuallyStopped = false;
    this.clearReconnectTimer();
    this.attemptConnect();
  }

  disconnect(): void {
    this.manuallyStopped = true;
    this.syncPeriodicCrouchChecks();
    this.clearRestartTimer();
    this.clearReconnectTimer();
    this.clearHangTimer();
    this.teardownSubprocess("Manual disconnect requested");
    this.setStatus("OFFLINE");
  }

  /** Wait before the website process exits: the Minecraft bot lives in a
   * separate JVM and needs its explicit stop request to complete. */
  async shutdown(): Promise<void> {
    const controller = this.subprocess;
    const closed = controller && controller.exitCode === null && controller.signalCode === null
      ? new Promise<void>(resolve => controller.once("close", () => resolve())) : Promise.resolve();
    this.disconnect();
    await Promise.all([closed, this.pendingStop]);
  }

  restart(): void {
    this.manuallyStopped = false;
    this.clearRestartTimer();
    this.clearReconnectTimer();
    this.clearHangTimer();
    this.teardownSubprocess("Restart requested");
    this.setStatus("OFFLINE");
    this.emitConsole("SYSTEM", "Restart: waiting 5 seconds before reconnecting...");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.manuallyStopped) this.attemptConnect();
    }, MANUAL_RESTART_DELAY_MS);
  }

  sendCommand(command: string): boolean {
    if (isBlockedAfkCommand(command)) {
      this.emitConsole("WARNING", AFK_BLOCK_MESSAGE);
      return true; // Locally handled; no command reaches the game server.
    }
    if (!isSlashCommand(command)) {
      this.emitConsole("ERROR", "Nur Slash-Befehle mit / am Anfang sind erlaubt");
      return false;
    }
    if (this.status !== "ONLINE" || !this.subprocess) {
      this.emitConsole("ERROR", "Bot is not online, cannot send command");
      return false;
    }
    const sent = this.sendToBot(command === "/desmo" ? { type: "read_sell_multipliers" } : { type: "chat", text: command });
    if (sent) this.emitConsole("USER_COMMAND", command);
    else this.emitConsole("ERROR", "Command konnte nicht an den Bot übermittelt werden");
    return sent;
  }

  sendChat(message: string): void {
    this.sendCommand(message);
  }


  /**
   * Queue a clean-spawner run on the bot. The bot right-clicks a spawner within
   * reach (never walking to it) and drops the container's items. Runs through
   * the bot's foreground task queue, so it pauses/resumes auto-sell cleanly.
   */
  cleanSpawner(): boolean {
    if (this.status !== "ONLINE" || !this.subprocess) {
      this.emitConsole("ERROR", "Bot is not online, cannot clean spawner");
      return false;
    }
    this.sendToBot({ type: "clean_spawner" });
    this.emitConsole("SYSTEM", "Clean spawner task dispatched");
    return true;
  }

  private attemptConnect(reconnecting = false): void {
    this.connectionEnded = false;
    this.setStatus(reconnecting ? "RECONNECTING" : "CONNECTING");
    this.lastError = undefined;

    this.log.info(
      `Connecting to ${this.config.serverHost}:${this.config.serverPort}`,
    );

    let child: SoulFireController;
    try {
      child = createSoulFireController();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err }, `Failed to spawn bot subprocess: ${message}`);
      this.handleConnectionFailure(message);
      return;
    }

    this.subprocess = child;
    // Pipe failures are asynchronous stream errors, not child-process errors.
    // Keep this listener after teardown: the final disconnect write can fail
    // after this.subprocess has already been cleared or replaced.
    child.stdin?.on("error", (err: Error) => {
      if (child !== this.subprocess) return;
      this.log.warn({ err }, "Bot input pipe failed");
      this.handleConnectionFailure(`Bot input pipe failed: ${err.message}`);
    });
    this.lastHeartbeatAt = Date.now();
    this.startOnlineWatchdog();

    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (child !== this.subprocess) return; // ignore a superseded process
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        this.handleBotEvent(JSON.parse(trimmed));
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
      account_id: this.config.id,
      edition: this.config.edition,
      // Both editions resolve their protocol through SoulFire.
      version: this.config.minecraftVersion,
      email: this.config.credentialsSecret,
      password: this.config.credentialsPassword,
      cache_dir: cacheDir,
      crouch_enabled: this.config.crouchEnabled,
      auto_button: (this.config.autoButton ?? "OFF").toLowerCase(),
      autosell_enabled: this.config.autoSellEnabled,
      autosell_interval_seconds: this.config.autoSellIntervalSeconds,
      autosell_command: this.config.autoSellCommand,
      ...this.sellPauseWindow(),
      spawner_type: this.config.spawnerType,
      spawner_drop_items: this.config.spawnerDropItems,
      spawner_sell_items: this.config.spawnerSellItems,
    });

    this.hangTimer = setTimeout(() => {
      if (this.status === "CONNECTING" || this.status === "RECONNECTING") {
        this.log.warn("Bot subprocess hang timeout, recycling");
        this.handleConnectionFailure("Connection timed out");
      }
    }, SUBPROCESS_HANG_TIMEOUT_MS);
  }

  private sellPauseWindow(): { autosell_pause_after_ms: number; autosell_resume_after_ms: number } {
    const now = Date.now();
    if (this.worldRestartAt === null || now >= this.worldRestartAt + WORLD_RESTART_SELL_COOLDOWN_MS) {
      return { autosell_pause_after_ms: 0, autosell_resume_after_ms: 0 };
    }
    return {
      autosell_pause_after_ms: Math.max(0, this.worldRestartAt - WORLD_RESTART_SELL_LEAD_MS - now),
      autosell_resume_after_ms: this.worldRestartAt + WORLD_RESTART_SELL_COOLDOWN_MS - now,
    };
  }

  /** Five minute checks anchored to the <=10s announcement, retained across bot reconnects. */
  private scheduleRestartCrouchChecks(restartAt: number): void {
    if (this.lastCrouchRestartAt !== null && Math.abs(restartAt - this.lastCrouchRestartAt) <= 5000) return;
    this.lastCrouchRestartAt = restartAt;
    if (this.restartCrouchTimer) clearInterval(this.restartCrouchTimer);
    this.restartCrouchWindowEnd = Date.now() + 5 * 60_000;
    this.pendingRestartCrouchCheck = false;
    let remaining = 5;
    this.restartCrouchTimer = setInterval(() => {
      if (this.config.crouchEnabled) {
        this.pendingRestartCrouchCheck = !this.sendRestartCrouchCheck();
      }
      if (--remaining === 0 && this.restartCrouchTimer) {
        clearInterval(this.restartCrouchTimer);
        this.restartCrouchTimer = null;
      }
    }, 60_000);
  }

  private sendRestartCrouchCheck(): boolean {
    return this.status === "ONLINE" && this.config.crouchEnabled && this.sendToBot({ type: "check_crouch" });
  }

  private handleBotEvent(event: Record<string, unknown>): void {
    const type = event.type as string;

    switch (type) {
      case "msa_code": {
        const { verification_uri, user_code, expires_in } = event as {
          verification_uri: string;
          user_code: string;
          expires_in: number;
        };
        this.clearHangTimer();
        this.hangTimer = setTimeout(() => this.handleConnectionFailure("Microsoft-Anmeldung abgelaufen"), Math.min(expires_in, 900) * 1000 + 15_000);
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
        this.clearHangTimer();
        this.hangTimer = setTimeout(() => this.handleConnectionFailure("Connection timed out"), SUBPROCESS_HANG_TIMEOUT_MS);
        this.msaSignIn = undefined;
        this.authenticated = true;
        this.emitConsole("SYSTEM", `Authenticated as ${username}`);
        this.emit("profile", { minecraftAccountId: this.config.id, username, uuid } as ProfileEvent);
        // Complete the website sign-in flow even if the game server is slow
        // or unreachable. CONNECTING itself has not changed at this point.
        this.emitStatus();
        break;
      }

      case "login":
        this.emitConsole("SYSTEM", "Logged in, joining world...");
        break;

      case "spawn":
        this.clearHangTimer();
        this.lastHeartbeatAt = Date.now();
        this.connectedSince = new Date();
        this.msaSignIn = undefined;
        this.lastError = undefined;
        this.setStatus("ONLINE");
        this.emitConsole("SYSTEM", "Spawned into the world");
        if (this.pendingRestartCrouchCheck && Date.now() <= this.restartCrouchWindowEnd && this.sendRestartCrouchCheck()) {
          this.pendingRestartCrouchCheck = false;
        }
        break;

      case "chat": {
        const { sender, message } = event as { sender: string | null; message: string };
        const clean = stripMinecraftFormatting(message);
        // HugoSMP sends its own announcements through the named chat channel.
        const fromServer = !sender || stripMinecraftFormatting(sender).toLowerCase() === "hugosmp";
        if (fromServer) {
          const seconds = parseWorldRestartSeconds(clean);
          if (seconds !== null) {
            this.worldRestartAt = Date.now() + seconds * 1000;
            if (seconds <= 10) this.scheduleRestartCrouchChecks(this.worldRestartAt);
            this.sendToBot({ type: "pause_autosell", ...this.sellPauseWindow() });
            this.emitConsole("SYSTEM", "Weltneustart: AutoSell pausiert ab 10 Sekunden vorher bis 2 Minuten danach");
          }
        }
        const amount = parseSellEarning(clean);
        if (amount !== null) {
          this.emit("earning", { minecraftAccountId: this.config.id, amount });
        }
        this.emit("chat", { minecraftAccountId: this.config.id, message: clean });
        if (sender) this.emitConsole("CHAT", `<${stripMinecraftFormatting(sender)}> ${clean}`);
        else this.emitConsole("SERVER_MESSAGE", clean);
        if (fromServer && isServerFallbackMessage(clean)) {
          // The proxy connection and tick heartbeats can remain healthy on the
          // fallback server. Neither a disconnect nor the hang watchdog fires.
          this.emitConsole("WARNING", "Spielserver-Verbindung verloren; Wiederverbindung gemäß Auto-Reconnect-Einstellung");
          this.handleConnectionFailure(clean);
        }
        break;
      }

      case "behavior_log":
        this.emitConsole("SYSTEM", String((event as { message: string }).message));
        break;

      case "sell_multipliers": {
        const entries = event.entries;
        if (!Array.isArray(entries) || entries.length !== 9 || !entries.every(entry => entry && typeof entry.name === "string"
          && entry.name.trim().length > 0 && entry.name.length <= 256 && typeof entry.multiplier === "string"
          && entry.multiplier.length <= 32 && /^\d+(?:[.,]\d+)?[x×]$/iu.test(entry.multiplier)
          && typeof entry.progress === "string" && entry.progress.length <= 96
          && /^\d[\d.,]*[KMBT]?\$\/\d[\d.,]*[KMBT]?\$ - \d+(?:[.,]\d+)?%$/iu.test(entry.progress))) {
          this.emitConsole("WARNING", "Desmo: Multiplikatoren konnten nicht vollständig ausgelesen werden");
          break;
        }
        this.emitConsole("SYSTEM", "Desmo: Verkaufsmultiplikatoren (9 Kategorien)\n\n" + entries.map(entry =>
          `${stripMinecraftFormatting(entry.name).replace(/[\r\n]/g, " ").trim()}\n  Aktueller Multiplikator: ${entry.multiplier}\n  Fortschritt: ${entry.progress}`).join("\n\n"));
        break;
      }

      case "heartbeat":
        this.lastHeartbeatAt = Date.now();
        break;

      case "warning":
        this.emitConsole("WARNING", String((event as { message: string }).message));
        break;

      case "disconnect": {
        const reason = (event as { reason?: string | null }).reason ?? "unknown reason";
        this.emitConsole("SYSTEM", `Disconnected: ${reason}`);
        this.handleConnectionFailure(reason);
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

    const delay = RECONNECT_DELAY_MS;
    const seconds = Math.round(delay / 1000);
    this.setStatus("RECONNECTING");
    this.emitConsole("SYSTEM", `Reconnecting in ${seconds}s...`);
    this.log.info({ delay }, `Reconnecting in ${seconds}s`);

    this.reconnectTimer = setTimeout(() => this.attemptConnect(true), delay);
  }

  private teardownSubprocess(reason: string): void {
    this.clearOnlineWatchdog();
    const child = this.subprocess;
    this.subprocess = null;
    this.connectedSince = null;
    this.msaSignIn = undefined;
    this.authenticated = false;
    if (!child) return;

    this.log.debug(reason);
    try {
      if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded && child.stdin.writable) {
        child.stdin.write(JSON.stringify({ type: "disconnect" }) + "\n");
      }
    } catch {
      /* stdin may already be gone */
    }

    this.pendingStop = stopRemoteAccount(path.join(appConfig.dataDir, "bot-cache", this.config.id))
      .catch(err => this.log.warn({ err }, "Could not stop shared SoulFire bot"));
    terminateSubprocess(child, 500, 4000);
  }

  private sendToBot(payload: Record<string, unknown>): boolean {
    const input = this.subprocess?.stdin;
    if (!input || input.destroyed || input.writableEnded || !input.writable) return false;
    try {
      // false from write() means backpressure, not rejection: Node still queues
      // those bytes. Only an unavailable pipe or an exception is a failure.
      input.write(JSON.stringify(payload) + "\n");
      return true;
    } catch (err) {
      this.log.debug({ err }, "Failed to write to bot stdin");
      return false;
    }
  }

  private setStatus(newStatus: ClientStatus): void {
    if (this.status === newStatus) return;
    this.log.debug(`Status: ${this.status} -> ${newStatus}`);
    this.status = newStatus;
    this.syncPeriodicCrouchChecks();
    this.emitStatus();
  }

  private syncPeriodicCrouchChecks(): void {
    if (this.manuallyStopped || !this.config.crouchEnabled || this.status === "ERROR") {
      if (this.periodicCrouchTimer) clearInterval(this.periodicCrouchTimer);
      this.periodicCrouchTimer = null;
      this.pendingPeriodicCrouchCheck = false;
    } else if (this.status === "ONLINE") {
      if (this.pendingPeriodicCrouchCheck && this.sendToBot({ type: "check_crouch" })) {
        this.pendingPeriodicCrouchCheck = false;
      }
      if (!this.periodicCrouchTimer) {
        // Preserve this cadence across world changes and reconnects. If the
        // account is temporarily offline at the deadline, check on its rejoin.
        this.periodicCrouchTimer = setInterval(() => {
          this.pendingPeriodicCrouchCheck = this.status !== "ONLINE"
            || !this.sendToBot({ type: "check_crouch" });
        }, 30 * 60_000);
      }
    }
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

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
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
      const silentFor = Date.now() - this.lastHeartbeatAt;
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

}
