import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type {
  ConsoleEventType,
  SniperConsoleEvent,
  SniperRuntimeConfig,
  SniperStatusSnapshot,
} from "./types.js";
import type { ClientStatus, MsaSignInPrompt } from "../minecraft/types.js";
import { accountLogger } from "../logging/logger.js";
import { config as appConfig } from "../config/config.js";
import type { Logger } from "pino";

// Safety net: if the subprocess never authenticates within this window, treat
// it as hung and recycle it (mirrors MinecraftClient's connect hang timer).
const SUBPROCESS_HANG_TIMEOUT_MS = 2 * 60_000;

/**
 * Wraps the standalone `namesniper-bot` Rust subprocess (one per Name Sniper
 * account). Unlike MinecraftClient, this subprocess never joins a Minecraft
 * server — it authenticates a Microsoft account and then loops, repeatedly
 * attempting to rename it to the configured desired name.
 *
 * Speaks the same NDJSON-over-stdio pattern (SniperConfig once, then
 * SniperCommand lines in / OutEvent lines out), reusing several OutEvent
 * variants (msa_code, profile, warning, fatal_error, heartbeat) verbatim from
 * the Minecraft bot protocol.
 *
 * Emitted events:
 *   - "status"   (SniperStatusSnapshot)  status/detail changed
 *   - "console"  (SniperConsoleEvent)    a console line to display/persist
 *   - "achieved" ({ id, name })          the rename succeeded; caller should
 *                                        persist enabled=false and stop.
 */
export class SniperClient extends EventEmitter {
  private subprocess: ChildProcess | null = null;
  private status: ClientStatus = "OFFLINE";
  private hangTimer: NodeJS.Timeout | null = null;
  private manuallyStopped = true;
  /** Set right before we ask the subprocess to stop, so its resulting exit(0)
   * isn't misread as "rename succeeded on its own". */
  private stopRequested = false;
  private connectionEnded = false;
  private lastError: string | undefined;
  private msaSignIn: MsaSignInPrompt | undefined;
  private authenticated = false;
  private currentName: string | undefined;
  private lastAttemptAt: Date | undefined;
  private lastResult: string | undefined;
  private lastSuccess = false;
  private readonly log: Logger;

  constructor(private config: SniperRuntimeConfig) {
    super();
    this.log = accountLogger(config.id, `sniper:${config.email}`);
  }

  dispose(): void {
    this.stop();
  }

  updateConfig(config: SniperRuntimeConfig): void {
    this.config = config;
    if (this.subprocess && this.status === "ONLINE") {
      this.sendToBot({
        type: "configure",
        desired_name: config.desiredName,
        cooldown_seconds: config.cooldownSeconds,
      });
    }
  }

  getStatus(): SniperStatusSnapshot {
    return {
      id: this.config.id,
      status: this.status,
      msaSignIn: this.msaSignIn,
      authenticated: this.authenticated,
      lastError: this.lastError,
      currentName: this.currentName,
      lastAttemptAt: this.lastAttemptAt?.toISOString(),
      lastResult: this.lastResult,
      lastSuccess: this.lastSuccess,
    };
  }

  start(): void {
    if (this.status !== "OFFLINE" && this.status !== "ERROR") return;
    this.manuallyStopped = false;
    this.stopRequested = false;
    this.attemptStart();
  }

  stop(): void {
    this.manuallyStopped = true;
    this.stopRequested = true;
    this.clearHangTimer();
    this.teardownSubprocess("Manual stop requested");
    this.setStatus("OFFLINE");
  }

  private attemptStart(): void {
    this.connectionEnded = false;
    this.setStatus("CONNECTING");
    this.lastError = undefined;

    const binaryPath = this.findBotBinary();
    if (!binaryPath) {
      const err = "namesniper-bot binary not found";
      this.log.error(err);
      this.emitConsole("ERROR", err);
      this.handleFailure(err);
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(binaryPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, RUST_LOG: "error" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err }, `Failed to spawn sniper subprocess: ${message}`);
      this.handleFailure(message);
      return;
    }

    this.subprocess = child;

    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (child !== this.subprocess) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        this.handleBotEvent(JSON.parse(trimmed));
      } catch (err) {
        this.log.debug({ err, line: trimmed }, "Ignoring non-JSON sniper output");
      }
    });

    child.stderr?.on("data", (data) => {
      if (child !== this.subprocess) return;
      this.log.debug({ data: data.toString() }, "Sniper stderr");
    });

    child.on("close", (code, signal) => {
      if (child !== this.subprocess) return;
      this.log.info({ code, signal }, "Sniper subprocess closed");
      if (this.manuallyStopped) {
        this.teardownSubprocess("Subprocess closed after manual stop");
        return;
      }
      if (code === 0 && !this.stopRequested) {
        // Clean exit that wasn't requested by us: the rename succeeded and
        // the Rust process exited on its own (see namesniper.rs). The final
        // rename_result event already updated currentName/lastSuccess.
        this.teardownSubprocess("Rename achieved, stopping");
        this.setStatus("OFFLINE");
        this.emit("achieved", { id: this.config.id, name: this.currentName });
        return;
      }
      this.handleFailure(code && code !== 0 ? `Bot exited with code ${code}` : "Connection ended");
    });

    child.on("error", (err) => {
      if (child !== this.subprocess) return;
      this.log.error(err, "Sniper subprocess error");
      this.handleFailure(err.message);
    });

    const cacheDir = path.join(appConfig.dataDir, "sniper-cache", this.config.id);
    this.sendToBot({
      email: this.config.email,
      cache_dir: cacheDir,
      desired_name: this.config.desiredName,
      cooldown_seconds: this.config.cooldownSeconds,
    });

    this.hangTimer = setTimeout(() => {
      if (this.status === "CONNECTING") {
        this.log.warn("Sniper subprocess hang timeout, recycling");
        this.handleFailure("Authentication timed out");
      }
    }, SUBPROCESS_HANG_TIMEOUT_MS);
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
        this.msaSignIn = {
          verificationUri: verification_uri,
          userCode: user_code,
          message: `Visit ${verification_uri} and enter code ${user_code}`,
          expiresAt: new Date(Date.now() + expires_in * 1000).toISOString(),
        };
        this.emitConsole("SYSTEM", `Microsoft-Anmeldung erforderlich: ${verification_uri} (Code: ${user_code})`);
        this.emitStatus();
        break;
      }

      case "profile": {
        const { username, uuid } = event as { username: string; uuid: string };
        this.clearHangTimer();
        this.authenticated = true;
        this.msaSignIn = undefined;
        this.currentName = username;
        this.setStatus("ONLINE");
        this.emitConsole("SYSTEM", `Angemeldet als ${username} (${uuid})`);
        break;
      }

      case "rename_attempt": {
        const { desired_name } = event as { desired_name: string };
        this.lastAttemptAt = new Date();
        this.emitConsole("SERVER_MESSAGE", `Versuche Namensänderung zu "${desired_name}"...`);
        this.emitStatus();
        break;
      }

      case "rename_result": {
        const { success, message, current_name } = event as {
          success: boolean;
          message: string;
          current_name: string | null;
        };
        this.lastResult = message;
        this.lastSuccess = success;
        if (current_name) this.currentName = current_name;
        this.emitConsole(success ? "SYSTEM" : "ERROR", message);
        this.emitStatus();
        break;
      }

      case "warning":
        this.emitConsole("WARNING", String((event as { message: string }).message));
        break;

      case "heartbeat":
        break;

      case "fatal_error": {
        const error = String((event as { error: string }).error);
        this.emitConsole("ERROR", `Fataler Fehler: ${error}`);
        this.handleFailure(error);
        break;
      }

      default:
        this.log.debug({ type }, "Unknown sniper bot event type");
    }
  }

  private handleFailure(reason: string): void {
    if (this.connectionEnded) return;
    this.connectionEnded = true;
    this.lastError = reason;
    this.clearHangTimer();
    this.teardownSubprocess(`Ended: ${reason}`);

    if (this.manuallyStopped) {
      this.setStatus("OFFLINE");
      return;
    }

    // Unlike MinecraftClient, we do not auto-reconnect on failure: an
    // authentication/subprocess failure here is very likely persistent (bad
    // credentials, expired token needing manual re-auth, etc.) and silently
    // retrying could hammer Mojang's API. The admin can retry manually via
    // the "start" action once the underlying issue is resolved.
    this.emitConsole("ERROR", `Name Sniper gestoppt: ${reason}`);
    this.setStatus("ERROR");
  }

  private teardownSubprocess(reason: string): void {
    const child = this.subprocess;
    this.subprocess = null;
    this.msaSignIn = undefined;
    this.authenticated = false;
    if (!child) return;

    this.log.debug(reason);
    try {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(JSON.stringify({ type: "stop" }) + "\n");
      }
    } catch {
      /* stdin may already be gone */
    }

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
      this.log.debug({ err }, "Failed to write to sniper stdin");
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

  private clearHangTimer(): void {
    if (this.hangTimer) {
      clearTimeout(this.hangTimer);
      this.hangTimer = null;
    }
  }

  private emitConsole(type: ConsoleEventType, message: string): void {
    this.emit("console", {
      sniperAccountId: this.config.id,
      type,
      message,
      timestamp: new Date().toISOString(),
    } as SniperConsoleEvent);
  }

  /** Locate the compiled namesniper-bot binary (Docker image or local dev build). */
  private findBotBinary(): string | null {
    const candidates = [
      "/app/namesniper-bot",
      path.join(process.cwd(), "rust-bot", "target", "release", "namesniper-bot"),
      path.join(process.cwd(), "rust-bot", "target", "debug", "namesniper-bot"),
      path.join(process.cwd(), "..", "rust-bot", "target", "release", "namesniper-bot"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
      if (existsSync(candidate + ".exe")) return candidate + ".exe";
    }
    return null;
  }
}
