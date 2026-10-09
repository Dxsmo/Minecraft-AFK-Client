//! Bedrock Minecraft bot subprocess (one process == one Bedrock account).
//!
//! Driven entirely over stdio with the same NDJSON protocol as the Azalea Java
//! bot (see ./protocol.ts). The Node backend spawns this via
//! `node dist/bedrock-bot/index.js` when an account's edition is BEDROCK, and
//! owns the reconnect policy — this process just exits when the connection ends.
//!
//! NOTE: bedrock-protocol is a low-level packet client and exact packet schemas
//! vary by protocol version. This bot implements the console/automation feature
//! set reliably; auto-sell menus are unverified against a live Bedrock server, and
//! clean-spawner is unavailable.

import { mkdirSync } from "node:fs";
import readline from "node:readline";
import { createClient } from "bedrock-protocol";

import { emit, type Command, type Config } from "./protocol.js";
import { BotSender } from "./send.js";
import { BehaviorState } from "./behaviors.js";
import { BedrockConnectionProgress, bedrockLoginFailure } from "./connection.js";
import { bedrockVersion } from "./version.js";
import { discoverBedrockServer } from "./discovery.js";

const CONNECT_TIMEOUT_MS =
  (Number.parseInt(process.env.BOT_CONNECT_TIMEOUT_SECS ?? "", 10) || 45) * 1000;

let exiting = false;
function endProcess(code: number): void {
  if (exiting) return;
  exiting = true;
  // Give stdout a tick to flush the final NDJSON line before exiting.
  setTimeout(() => process.exit(code), 50);
}

process.on("uncaughtException", (err) => {
  emit({ type: "fatal_error", error: `Uncaught error: ${err?.message ?? String(err)}` });
  endProcess(1);
});
process.on("unhandledRejection", (reason) => {
  emit({ type: "fatal_error", error: `Unhandled rejection: ${String(reason)}` });
  endProcess(1);
});

async function main(): Promise<void> {
  const config = await readConfig();
  if (!config) {
    emit({ type: "fatal_error", error: "No config received on stdin" });
    endProcess(1);
    return;
  }

  if (config.cache_dir) {
    try {
      mkdirSync(config.cache_dir, { recursive: true });
    } catch {
      /* best-effort; auth cache just won't persist */
    }
  }

  const isMicrosoft = config.auth_type.toLowerCase() === "microsoft";
  const version = (config.version ?? "").trim();
  const progress = new BedrockConnectionProgress(CONNECT_TIMEOUT_MS);
  emit({ type: "behavior_log", message: `Bedrock: Connecting to ${config.host}:${config.port || 19132} (version ${version || "auto"})` });

  let client: ReturnType<typeof createClient>;
  try {
    // The library's auto mode compares the display version literally ("26.51")
    // and otherwise silently falls back to an older protocol ("1.26.40").
    // Resolve the advertised wire protocol first, then pass a concrete version.
    const advertised = await discoverBedrockServer(config.host, config.port || 19132, Math.min(CONNECT_TIMEOUT_MS, 5000));
    const selectedVersion = bedrockVersion(advertised, version);
    emit({ type: "behavior_log", message: `Bedrock: Server protocol ${advertised.protocol}; using client version ${selectedVersion}${version ? " (configured)" : " (auto)"}` });
    progress.advance("authentication");
    emit({ type: "behavior_log", message: "Bedrock: Server discovered; authenticating Microsoft/Xbox session" });
    client = createClient({
      host: config.host,
      port: config.port || 19132,
      username: config.username,
      offline: !isMicrosoft,
      // A proxy may advertise its internal/default port instead of the public
      // port entered on the website. Always use the configured endpoint.
      followPort: false,
      // One Bedrock account per process is light; run RakNet inline rather than
      // in a worker thread. Uses bedrock-protocol's default native RakNet
      // backend (compiled in the Docker image; see backend/Dockerfile).
      // The installed library's declarations still spell this in the singular.
      ...{ useRaknetWorkers: false },
      version: selectedVersion as never,
      // Discovery already completed over a separate, closed UDP socket.
      // Keep the native peer solely for the actual connection.
      skipPing: true,
      ...(isMicrosoft ? { profilesFolder: config.cache_dir } : {}),
      connectTimeout: CONNECT_TIMEOUT_MS,
      // Default library logs are plain stdout and get discarded by our NDJSON
      // reader. Forward only its connection messages, never token/debug dumps.
      conLog: (...messages: unknown[]) => emit({ type: "behavior_log", message: `Bedrock: ${messages.map(String).join(" ")}` }),
      onMsaCode: (data) => {
        emit({
          type: "msa_code",
          verification_uri: data.verification_uri,
          user_code: data.user_code,
          expires_in: data.expires_in,
        });
        // A device-code sign-in needs human time; push the connect watchdog out.
        progress.waitForDeviceCode(data.expires_in);
      },
    });
  } catch (err) {
    emit({ type: "fatal_error", error: `Failed to start Bedrock client: ${errMsg(err)}` });
    endProcess(1);
    return;
  }

  const c = client as unknown as { on(event: string, cb: (...args: unknown[]) => void): void; close?: () => void; disconnect?: () => void };
  const sender = new BotSender(client as never, config.username);
  const behavior = new BehaviorState(config, sender);

  // Connect watchdog: if we never spawn, exit so Node can reschedule.
  let spawned = false;
  const watchdog = setInterval(() => {
    if (progress.timedOut) {
      const options = (client as unknown as { options?: { version?: string } }).options;
      emit({ type: "connection_failed", error: progress.timeoutMessage(config.host, config.port || 19132, options?.version ?? version) });
      shutdown(1);
    }
  }, 1000);

  // Behavior tick.
  const tick = setInterval(() => {
    try {
      behavior.onTick();
    } catch (err) {
      emit({ type: "warning", message: `Behavior tick error: ${errMsg(err)}` });
    }
  }, 50);

  const shutdown = (code: number) => {
    clearInterval(watchdog);
    clearInterval(tick);
    endProcess(code);
    try { c.close?.(); } catch { /* process exit still closes native sockets */ }
  };

  // --- Lifecycle events ---
  const onSession = () => {
    if (!progress.advance("transport")) return;
    const profile = (client as unknown as { profile?: { name: string; uuid: string } }).profile;
    if (profile?.name) emit({ type: "profile", username: profile.name, uuid: profile.uuid ?? "" });
    emit({ type: "behavior_log", message: "Bedrock: Session ready; establishing RakNet/UDP connection" });
  };
  c.on("session", onSession);
  // Offline sessions can be ready synchronously when skipPing is enabled.
  if ((client as unknown as { profile?: { name?: string } }).profile?.name) onSession();
  c.on("loggingIn", () => {
    progress.advance("login");
    emit({ type: "behavior_log", message: "Bedrock: Transport connected; sending server login" });
  });
  c.on("resource_packs_info", () => progress.advance("resources"));
  c.on("play_status", (packet: unknown) => {
    const failure = bedrockLoginFailure(packet);
    if (failure && !exiting) {
      emit({ type: "connection_failed", error: failure });
      shutdown(1);
    }
  });
  c.on("join", () => {
    progress.advance("resources");
    behavior.markJoining();
    emit({ type: "login" });
  });

  c.on("spawn", () => {
    progress.advance("spawned");
    clearInterval(watchdog);
    spawned = true;
    behavior.markSpawned();
    emit({ type: "spawn" });
  });

  const onGone = (reason: string) => {
    if (exiting) return;
    emit({ type: "disconnect", reason: reason || null });
    shutdown(0);
  };
  c.on("disconnect", (packet: unknown) => onGone(reasonOf(packet)));
  c.on("kick", (packet: unknown) => onGone(reasonOf(packet)));
  c.on("close", () => {
    if (!exiting) onGone("Connection closed");
  });
  c.on("error", (err: unknown) => {
    if (exiting) return;
    const options = (client as unknown as { options?: { version?: string } }).options;
    emit({ type: "connection_failed", error: progress.failureMessage(errMsg(err), config.host, config.port || 19132, options?.version ?? version) });
    shutdown(1);
  });

  // --- World / telemetry packets (all defensive) ---
  let localRuntimeEntityId: bigint | null = null;
  c.on("start_game", (packet: unknown) => {
    progress.advance("world");
    try {
      const p = packet as { runtime_entity_id?: unknown; player_position?: unknown; rotation?: { x?: number; z?: number }; current_tick?: unknown; server_authoritative_inventory?: boolean };
      const id = toBigIntOrNull(p.runtime_entity_id);
      localRuntimeEntityId = id;
      sender.setRuntimeEntityId(id);
      sender.updatePosition(p.player_position, p.rotation?.x, p.rotation?.z);
      sender.setInputTick(toBigIntOrNull(p.current_tick) ?? 0n);
      sender.authoritativeInventory = p.server_authoritative_inventory !== false;
      if (spawned) behavior.markTeleported();
    } catch {
      /* ignore */
    }
  });

  // Proxies can switch dimension/world without another high-level spawn.
  c.on("change_dimension", (packet: unknown) => {
    const p = packet as { position?: unknown };
    sender.updatePosition(p.position, undefined, undefined, true);
    behavior.markTeleported();
  });

  c.on("move_player", (packet: unknown) => {
    try {
      const p = packet as { runtime_id?: unknown; mode?: unknown; position?: unknown; pitch?: number; yaw?: number };
      const id = toBigIntOrNull(p.runtime_id);
      const teleport = p.mode === "teleport" || p.mode === 2;
      if (id != null && id === localRuntimeEntityId) {
        sender.updatePosition(p.position, p.pitch, p.yaw, teleport);
        if (teleport) behavior.markTeleported();
      }
    } catch {
      /* ignore malformed movement packet */
    }
  });

  // Apply inventory data in wire order, independently of dropped-item entities.
  c.on("block_entity_data", p => behavior.inventory.onBlockEntity(p as Parameters<typeof behavior.inventory.onBlockEntity>[0]));
  c.on("inventory_content", p => behavior.inventory.onContent(p as Parameters<typeof behavior.inventory.onContent>[0]));
  c.on("inventory_slot", p => behavior.inventory.onSlot(p as Parameters<typeof behavior.inventory.onSlot>[0]));
  c.on("container_open", p => behavior.inventory.onOpen(p as Parameters<typeof behavior.inventory.onOpen>[0]));
  c.on("container_close", p => behavior.inventory.onClose(p as Parameters<typeof behavior.inventory.onClose>[0]));
  c.on("item_stack_response", p => behavior.inventory.onResponse(p as Parameters<typeof behavior.inventory.onResponse>[0]));

  c.on("set_entity_data", (packet: unknown) => {
    const sneaking = sender.observeSneakMetadata(packet);
    if (sneaking !== null) behavior.onSneakStatus(sneaking);
  });

  c.on("set_health", (packet: unknown) => {
    try {
      const p = packet as { health?: number };
      if (typeof p.health === "number") behavior.reportHealth(p.health, null);
    } catch {
      /* ignore */
    }
  });

  c.on("update_attributes", (packet: unknown) => {
    try {
      const attrs = (packet as { attributes?: { name: string; current: number }[] }).attributes ?? [];
      let health: number | null = null;
      let food: number | null = null;
      for (const a of attrs) {
        if (a.name === "minecraft:health") health = a.current;
        if (a.name === "minecraft:player.hunger") food = a.current;
      }
      if (health != null || food != null) behavior.reportHealth(health, food);
    } catch {
      /* ignore */
    }
  });

  // --- Chat ---
  c.on("text", (packet: unknown) => {
    try {
      const p = packet as { type?: string; source_name?: string; message?: string };
      const message = p.message ?? "";
      if (!message) return;
      const withSender = p.source_name && p.type === "chat" ? p.source_name : null;
      emit({ type: "chat", sender: withSender, message });
      behavior.onChat(withSender, message);
    } catch {
      /* ignore malformed text packet */
    }
  });

  // --- stdin command loop ---
  startCommandReader((cmd) => handleCommand(cmd, behavior, c, shutdown));
}

function handleCommand(
  cmd: Command,
  behavior: BehaviorState,
  c: { close?: () => void; disconnect?: () => void },
  shutdown: (code: number) => void,
): void {
  switch (cmd.type) {
    case "chat":
      behavior.enqueueChat(cmd.text);
      break;
    case "background_chat":
      behavior.enqueueBackgroundChat(cmd.text);
      break;
    case "configure":
      behavior.updateConfig(cmd);
      break;
    case "check_crouch":
      behavior.checkCrouch();
      break;
    case "clean_spawner":
      behavior.enqueueCleanSpawner();
      break;
    case "pause_autosell":
      behavior.pauseAutosell(cmd.autosell_pause_after_ms, cmd.autosell_resume_after_ms);
      break;
    case "disconnect":
      try {
        c.disconnect?.();
        c.close?.();
      } catch {
        /* already closing */
      }
      shutdown(0);
      break;
  }
}

function reasonOf(packet: unknown): string {
  const p = packet as { message?: string; reason?: string } | string | undefined;
  if (typeof p === "string") return p;
  return p?.message ?? p?.reason ?? "Disconnected";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toBigIntOrNull(v: unknown): bigint | null {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(Math.trunc(v));
    if (typeof v === "string" && v.trim()) return BigInt(v);
  } catch {
    /* fall through */
  }
  return null;
}

/** Single shared stdin reader: first line is Config, the rest are Commands. */
const stdinReader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let onConfigLine: ((line: string) => void) | null = null;
let onCommandLine: ((line: string) => void) | null = null;
const bufferedCommands: string[] = [];
stdinReader.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  if (onConfigLine) {
    const handler = onConfigLine;
    onConfigLine = null;
    handler(t);
    return;
  }
  if (onCommandLine) onCommandLine(t);
  else bufferedCommands.push(t);
});

/** Resolve the first stdin line into a Config. */
function readConfig(): Promise<Config | null> {
  return new Promise((resolve) => {
    onConfigLine = (line) => {
      try {
        resolve(JSON.parse(line) as Config);
      } catch {
        resolve(null);
      }
    };
    stdinReader.on("close", () => resolve(null));
  });
}

/** Register the command handler and flush any lines that arrived early. */
function startCommandReader(onCommand: (cmd: Command) => void): void {
  onCommandLine = (line) => {
    try {
      onCommand(JSON.parse(line) as Command);
    } catch (err) {
      emit({ type: "warning", message: `Ignored malformed command: ${errMsg(err)}` });
    }
  };
  const early = bufferedCommands.splice(0);
  for (const line of early) onCommandLine(line);
}

main().catch((err) => {
  emit({ type: "fatal_error", error: `Startup failed: ${errMsg(err)}` });
  endProcess(1);
});
