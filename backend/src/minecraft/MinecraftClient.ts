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
  HugoSetting,
  InventoryItem,
  InventorySnapshot,
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
const SUBPROCESS_ONLINE_SILENCE_MS = 45_000;
/// How often the online-hang watchdog checks for subprocess silence.
const ONLINE_WATCHDOG_INTERVAL_MS = 15_000;

/// How often the daily-command / balance schedulers wake up. A 30s cadence is
/// fine for minute-granular daily times (deduped per day) and keeps overhead
/// negligible.
const SCHEDULER_TICK_MS = 30_000;

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
/// How often to poll the player's balance while balance polling is enabled.
const BALANCE_POLL_INTERVAL_MS = 5 * 60_000;
/// How often to re-query saved /homes while online, so the shortcut buttons
/// stay in sync even if a home is added/removed outside the web console.
const HOMES_POLL_INTERVAL_MS = 5 * 60_000;

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
  private authenticated = false;
  private readonly log: Logger;

  private health = 20;
  private food = 20;
  private balance: number | undefined;
  private balanceUpdatedAt: Date | undefined;
  /** Most recent live inventory snapshot from the bot, if any. */
  private inventory: InventorySnapshot | undefined;
  /** Last discovered /homes list for this account. */
  private homes: string[] = [];
  /** Last scanned server settings toggles for this account. */
  private hugoSettings: HugoSetting[] = [];
  /** While > now, incoming chat is scanned for /homes output lines. */
  private homesQueryUntil = 0;
  /** While > now, lines like "- homeName" are treated as /homes list entries. */
  private homesCollectUntil = 0;
  private homesCollect: string[] = [];
  /** Debounce timer that applies a collected /homes list once, after the
   *  bullet lines stop arriving, instead of flickering the shortcuts on every
   *  individual line. */
  private homesCollectTimer: NodeJS.Timeout | null = null;
  /** Epoch ms of the last /homes query, for the 5-minute refresh cadence. */
  private lastHomesQueryAt = 0;

  /** Drives the daily-command + balance-poll schedulers (see runScheduledTasks). */
  private schedulerTimer: NodeJS.Timeout | null = null;
  /** Maps a daily "HH:MM" to the YYYY-MM-DD it last fired, to run it once per day. */
  private firedDaily = new Map<string, string>();
  /** Epoch ms of the last balance query, for the 5-minute poll cadence. */
  private lastBalanceQueryAt = 0;

  constructor(private config: ClientRuntimeConfig) {
    super();
    this.log = accountLogger(config.id, config.name);
    this.homes = [...(config.homes ?? [])];
    this.hugoSettings = [...(config.hugoSettings ?? [])];
    this.schedulerTimer = setInterval(() => this.runScheduledTasks(), SCHEDULER_TICK_MS);
  }

  /** Stops all timers and disconnects; call when the account is removed. */
  dispose(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    this.disconnect();
  }

  updateConfig(config: ClientRuntimeConfig): void {
    this.config = config;
    // Push behavior settings to a running bot so changes take effect live.
    if (this.subprocess && this.status === "ONLINE") {
      this.sendToBot({
        type: "configure",
        afk_enabled: config.afkEnabled,
        movement_enabled: config.movementEnabled,
        crouch_enabled: config.crouchEnabled,
        afk_interval_seconds: config.afkIntervalSeconds,
        auto_command_enabled: config.autoCommandEnabled,
        auto_command_text: config.autoCommandText,
        auto_command_interval_minutes: config.autoCommandIntervalMinutes,
        auto_command_span_enabled: config.autoCommandSpanEnabled,
        auto_command_span_min_seconds: config.autoCommandSpanMinSeconds,
        auto_command_span_max_seconds: config.autoCommandSpanMaxSeconds,
        tpauto_enabled: config.tpAutoEnabled,
        tpauto_allowlist: config.tpAutoAllowlist,
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
      health: this.health,
      food: this.food,
      connectedSince: this.connectedSince?.toISOString(),
      lastError: this.lastError,
      reconnectAttempt: this.reconnectAttempt,
      msaSignIn: this.msaSignIn,
      authenticated: this.authenticated,
      balance: this.balance,
      balanceUpdatedAt: this.balanceUpdatedAt?.toISOString(),
      homes: this.homes,
      hugoSettings: this.hugoSettings,
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
    // If the user just created/updated a home (e.g. "/sethome base"), re-query
    // the homes list shortly after so the shortcut buttons pick it up. The
    // small delay gives the server time to register the new home first.
    if (/^\/sethome(\s|$)/i.test(command.trim())) {
      setTimeout(() => this.refreshHomes(), 1500);
    }
    return true;
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

  /** Ask the bot to emit a fresh inventory snapshot (received asynchronously). */
  requestInventory(): void {
    if (this.status !== "ONLINE" || !this.subprocess) return;
    this.sendToBot({ type: "request_inventory" });
  }

  /** Open the server settings GUI and scan its toggle buttons. The result
   *  arrives asynchronously as a "settings_menu" event. */
  scanHugoSettings(): boolean {
    if (this.status !== "ONLINE" || !this.subprocess) {
      this.emitConsole("ERROR", "Bot is not online, cannot scan settings");
      return false;
    }
    this.sendToBot({ type: "scan_settings", command: this.config.hugoSettingsCommand });
    this.emitConsole("SYSTEM", "Settings scan dispatched");
    return true;
  }

  /** Silent auto-scan triggered on every join. Unlike scanHugoSettings it does
   *  not log an error when the bot is offline (the join may not have settled). */
  private autoScanHugoSettings(): void {
    if (this.status !== "ONLINE" || !this.subprocess) return;
    this.sendToBot({ type: "scan_settings", command: this.config.hugoSettingsCommand });
  }

  /** Open the server settings GUI and toggle the button matching `label` to the
   *  desired `enabled` state. Refreshed settings arrive as a "settings_menu"
   *  event once the toggle settles. */
  setHugoSetting(label: string, enabled: boolean): boolean {
    if (this.status !== "ONLINE" || !this.subprocess) {
      this.emitConsole("ERROR", "Bot is not online, cannot change settings");
      return false;
    }
    this.sendToBot({
      type: "set_setting",
      command: this.config.hugoSettingsCommand,
      label,
      enabled,
    });
    this.emitConsole("SYSTEM", `Settings toggle dispatched: ${label} -> ${enabled ? "on" : "off"}`);
    return true;
  }

  /** Last scanned server settings toggles for this account. */
  getHugoSettings(): HugoSetting[] {
    return this.hugoSettings;
  }

  /** The most recently received inventory snapshot, if any. */
  getInventory(): InventorySnapshot | undefined {
    return this.inventory;
  }

  /** Move an item between two of the bot's own player-menu slots. */
  moveInventoryItem(from: number, to: number): boolean {
    if (this.status !== "ONLINE" || !this.subprocess) return false;
    this.sendToBot({ type: "move_item", from, to });
    return true;
  }

  /** Drop the whole stack in one of the bot's own player-menu slots. */
  dropInventoryItem(slot: number): boolean {
    if (this.status !== "ONLINE" || !this.subprocess) return false;
    this.sendToBot({ type: "drop_item", slot });
    return true;
  }

  /**
   * Runs the time-of-day daily-command scheduler and the periodic balance poll.
   * Both dispatch through the Rust bot's foreground task queue (RunTask /
   * QueryBalance), so they automatically pause any in-progress auto-sell cycle
   * and resume it afterwards — no scheduling logic lives in the bot itself.
   */
  private runScheduledTasks(): void {
    if (this.status !== "ONLINE" || !this.subprocess) return;

    // Daily command: fire the existing auto-command text once at each configured
    // time of day (server local time), deduped per day.
    const text = this.config.autoCommandText.trim();
    if (this.config.dailyCommandEnabled && text && this.config.dailyCommandTimes.length > 0) {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const today = now.toISOString().slice(0, 10);
      if (this.config.dailyCommandTimes.includes(hhmm) && this.firedDaily.get(hhmm) !== today) {
        this.firedDaily.set(hhmm, today);
        this.sendToBot({ type: "run_task", text });
        this.emitConsole("SYSTEM", `Daily command scheduled for ${hhmm} dispatched`);
      }
    }

    // Spawner clear: run the configured clear routine once at each configured
    // time of day, deduped per day (same pattern as the daily command above).
    if (this.config.spawnerClearEnabled && this.config.spawnerClearTimes.length > 0) {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const today = now.toISOString().slice(0, 10);
      const key = `spawner:${hhmm}`;
      if (this.config.spawnerClearTimes.includes(hhmm) && this.firedDaily.get(key) !== today) {
        this.firedDaily.set(key, today);
        this.sendToBot({ type: "clean_spawner" });
        this.emitConsole("SYSTEM", `Scheduled spawner clear for ${hhmm} dispatched`);
      }
    }

    // Balance poll: query at most every BALANCE_POLL_INTERVAL_MS.
    if (this.config.balanceEnabled) {
      const elapsed = Date.now() - this.lastBalanceQueryAt;
      if (elapsed >= BALANCE_POLL_INTERVAL_MS) {
        this.lastBalanceQueryAt = Date.now();
        const command = this.config.balanceCommand.trim() || "/balance";
        this.sendToBot({ type: "query_balance", command });
      }
    }

    // Homes poll: always re-query the saved /homes every 5 minutes so the
    // shortcut buttons stay accurate even without a reconnect.
    if (Date.now() - this.lastHomesQueryAt >= HOMES_POLL_INTERVAL_MS) {
      this.refreshHomes();
    }
  }

  /** Send a `/homes` query and open the parse window; refreshes the shortcut
   *  buttons via the resulting chat output. No-op unless online. */
  private refreshHomes(): void {
    if (this.status !== "ONLINE" || !this.subprocess) return;
    this.lastHomesQueryAt = Date.now();
    this.homesQueryUntil = Date.now() + 60_000;
    this.sendToBot({ type: "chat", text: "/homes" });
  }

  private attemptConnect(): void {
    this.connectionEnded = false;
    this.reconnectAttempt++;
    this.setStatus(this.reconnectAttempt > 1 ? "RECONNECTING" : "CONNECTING");
    this.lastError = undefined;

    this.log.info(
      `Connection attempt ${this.reconnectAttempt} to ${this.config.serverHost}:${this.config.serverPort}`,
    );

    const botBinaryPath = this.resolveBotLauncher();
    if (!botBinaryPath) {
      const err =
        this.config.edition === "BEDROCK"
          ? "bedrock-bot script not found"
          : "azalea-bot binary not found";
      this.log.error(err);
      this.emitConsole("ERROR", err);
      this.handleConnectionFailure(err);
      return;
    }

    let child: ChildProcess;
    try {
      // RUST_LOG=error keeps Azalea's own logging off stdout so it can't
      // interfere with the NDJSON protocol (any stray line is ignored anyway).
      child = spawn(botBinaryPath.command, botBinaryPath.args, {
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
      // Consumed by the Bedrock bot (empty = auto-detect); ignored by Azalea.
      version: this.config.minecraftVersion,
      email: this.config.credentialsSecret,
      password: this.config.credentialsPassword,
      cache_dir: cacheDir,
      afk_enabled: this.config.afkEnabled,
      movement_enabled: this.config.movementEnabled,
      crouch_enabled: this.config.crouchEnabled,
      afk_interval_seconds: this.config.afkIntervalSeconds,
      auto_command_enabled: this.config.autoCommandEnabled,
      auto_command_text: this.config.autoCommandText,
      auto_command_interval_minutes: this.config.autoCommandIntervalMinutes,
      auto_command_span_enabled: this.config.autoCommandSpanEnabled,
      auto_command_span_min_seconds: this.config.autoCommandSpanMinSeconds,
      auto_command_span_max_seconds: this.config.autoCommandSpanMaxSeconds,
      tpauto_enabled: this.config.tpAutoEnabled,
      tpauto_allowlist: this.config.tpAutoAllowlist,
      autosell_enabled: this.config.autoSellEnabled,
      autosell_interval_seconds: this.config.autoSellIntervalSeconds,
      autosell_command: this.config.autoSellCommand,
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
        this.authenticated = true;
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
        // Auto-refresh saved homes after each successful join.
        this.refreshHomes();
        // Auto-scan the server settings menu on every join so the website's
        // "HugoSMP Settings" toggles always reflect the live in-game state.
        setTimeout(() => this.autoScanHugoSettings(), 4000);
        break;

      case "chat": {
        const { sender, message } = event as { sender: string | null; message: string };
        const clean = stripMinecraftFormatting(message);
        this.tryUpdateHomesFromChat(clean);
        if (sender) this.emitConsole("CHAT", `<${stripMinecraftFormatting(sender)}> ${clean}`);
        else this.emitConsole("SERVER_MESSAGE", clean);
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

      case "balance": {
        const { balance } = event as { balance: number };
        this.balance = balance;
        this.balanceUpdatedAt = new Date();
        this.emitConsole("SYSTEM", `Balance: ${balance.toLocaleString("en-US")}`);
        this.emit("balance", { minecraftAccountId: this.config.id, balance });
        this.emitStatus();
        break;
      }

      case "sell_earning": {
        const { amount } = event as { amount: number };
        if (Number.isFinite(amount) && amount > 0) {
          this.emit("earning", { minecraftAccountId: this.config.id, amount });
        }
        break;
      }

      case "inventory": {
        const e = event as {
          main: (InventoryItem | null)[];
          hotbar: (InventoryItem | null)[];
          offhand: InventoryItem | null;
          armor: (InventoryItem | null)[];
          mutable: boolean;
        };
        this.inventory = {
          main: e.main ?? [],
          hotbar: e.hotbar ?? [],
          offhand: e.offhand ?? null,
          armor: e.armor ?? [],
          mutable: Boolean(e.mutable),
          updatedAt: new Date().toISOString(),
        };
        break;
      }

      case "warning":
        this.emitConsole("WARNING", String((event as { message: string }).message));
        break;

      case "settings_menu": {
        const e = event as { settings?: HugoSetting[] };
        const next = Array.isArray(e.settings)
          ? e.settings
              .filter((s) => s && typeof s.label === "string")
              .map((s) => ({ label: s.label, enabled: Boolean(s.enabled) }))
          : [];
        this.hugoSettings = next;
        this.emit("hugoSettings", { minecraftAccountId: this.config.id, settings: next });
        this.emitStatus();
        break;
      }

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
    this.authenticated = false;
    this.homesQueryUntil = 0;
    if (this.homesCollectTimer) {
      clearTimeout(this.homesCollectTimer);
      this.homesCollectTimer = null;
    }
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
    // A stale inventory snapshot is meaningless once the bot leaves the world.
    if (newStatus !== "ONLINE") this.inventory = undefined;
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

  private tryUpdateHomesFromChat(message: string): void {
    const now = Date.now();

    // Header line from servers like HugoSMP; following bullet lines carry names.
    if (/deine\s+homes\s*:/i.test(message) || /^homes\s*:/i.test(message)) {
      this.homesCollectUntil = now + 4_000;
      this.homesCollect = [];
      this.scheduleHomesFinalize();
      return;
    }

    // While collecting, accept bullet-list lines like "- spawner". We buffer the
    // names and apply them once (debounced) so the shortcut buttons update a
    // single time with the complete list, instead of flickering per line.
    if (now <= this.homesCollectUntil) {
      const bullet = message.match(/^\s*[-•]\s*([A-Za-z0-9_\-]{1,32})\s*$/);
      if (bullet?.[1]) {
        this.homesCollect.push(bullet[1]);
        this.scheduleHomesFinalize();
        return;
      }
    }

    // Always parse explicit "/home <name>" mentions; users may run /homes
    // manually at any time and still expect shortcuts to update.
    const explicit = Array.from(message.matchAll(/\/home\s+([A-Za-z0-9_\-]+)/gi)).map((m) => m[1]);
    if (explicit.length > 0) {
      this.applyHomes(explicit);
      return;
    }

    if (now > this.homesQueryUntil) return;
    const parsed = this.parseHomesLine(message);
    if (parsed === null) return;
    this.applyHomes(parsed);
  }

  /** (Re)arm the debounce that applies the buffered /homes bullet list once the
   *  lines stop arriving, so the shortcut buttons update a single time. */
  private scheduleHomesFinalize(): void {
    if (this.homesCollectTimer) clearTimeout(this.homesCollectTimer);
    this.homesCollectTimer = setTimeout(() => {
      this.homesCollectTimer = null;
      if (this.homesCollect.length > 0) this.applyHomes(this.homesCollect);
    }, 1200);
  }

  private applyHomes(candidates: string[]): void {
    const next = Array.from(new Set(candidates.map((h) => h.trim()).filter(Boolean)));
    if (next.length === this.homes.length && next.every((h, i) => h === this.homes[i])) return;
    this.homes = next;
    this.emit("homes", { minecraftAccountId: this.config.id, homes: this.homes });
    this.emitStatus();
  }

  private parseHomesLine(line: string): string[] | null {
    const lower = line.toLowerCase();
    // Explicit "no homes" style replies.
    if (
      (lower.includes("home") || lower.includes("homes")) &&
      (lower.includes("no home") || lower.includes("no homes") || lower.includes("keine homes"))
    ) {
      return [];
    }

    // Common server output style: "/home Name" entries in one line.
    const cmdMatches = Array.from(line.matchAll(/\/home\s+([A-Za-z0-9_\-]+)/g)).map((m) => m[1]);
    if (cmdMatches.length > 0) return cmdMatches;

    // Fallback: "Homes: Name1, Name2, Name3" / "Häuser: ..."
    if (lower.includes("homes") || lower.includes("häuser") || lower.includes("haeuser")) {
      const idx = line.indexOf(":");
      if (idx !== -1) {
        const tail = line.slice(idx + 1);
        const names = tail
          .replace(/[\[\]()]/g, " ")
          .split(/[,\|]/)
          .map((s) => s.trim())
          .filter((s) => /^[A-Za-z0-9_\-]{1,32}$/.test(s));
        if (names.length > 0) return names;
      }
    }
    return null;
  }

  /**
   * Resolve how to launch the bot subprocess for this account's edition.
   * Both editions speak the identical NDJSON protocol over stdio, so the rest
   * of this class is edition-agnostic:
   *   - JAVA    → the compiled Azalea Rust binary, run directly.
   *   - BEDROCK → the bedrock-protocol Node bot, run as `node dist/bedrock-bot/index.js`.
   */
  private resolveBotLauncher(): { command: string; args: string[] } | null {
    if (this.config.edition === "BEDROCK") {
      const script = this.findBedrockBotScript();
      return script ? { command: process.execPath, args: [script] } : null;
    }
    const binary = this.findBotBinary();
    return binary ? { command: binary, args: [] } : null;
  }

  /** Locate the compiled bedrock-bot entry (Docker image or local dev build). */
  private findBedrockBotScript(): string | null {
    const candidates = [
      "/app/dist/bedrock-bot/index.js",
      path.join(process.cwd(), "dist", "bedrock-bot", "index.js"),
      path.join(process.cwd(), "backend", "dist", "bedrock-bot", "index.js"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
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
