//! Bedrock Minecraft bot subprocess (one process == one Bedrock account).
//!
//! Driven entirely over stdio with the same NDJSON protocol as the Azalea Java
//! bot (see ./protocol.ts). The Node backend spawns this via
//! `node dist/bedrock-bot/index.js` when an account's edition is BEDROCK, and
//! owns the reconnect policy — this process just exits when the connection ends.
//!
//! NOTE: bedrock-protocol is a low-level packet client and exact packet schemas
//! vary by protocol version. This bot implements the full AFK/console/auto-*
//! feature set reliably; deeper container features (inventory item moves,
//! clean-spawner) are best-effort and unverified against a live Bedrock server.

import { mkdirSync } from "node:fs";
import readline from "node:readline";
import { createClient } from "bedrock-protocol";

import { emit, type Command, type Config, type InventorySlot } from "./protocol.js";
import { BotSender } from "./send.js";
import { BehaviorState } from "./behaviors.js";

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

  let client: ReturnType<typeof createClient>;
  try {
    client = createClient({
      host: config.host,
      port: config.port || 19132,
      username: config.username,
      offline: !isMicrosoft,
      // One Bedrock account per process is light; run RakNet inline rather than
      // in a worker thread. Uses bedrock-protocol's default native RakNet
      // backend (compiled in the Docker image; see backend/Dockerfile).
      useRaknetWorker: false,
      ...(version ? { version: version as never } : {}),
      ...(isMicrosoft ? { profilesFolder: config.cache_dir } : {}),
      connectTimeout: CONNECT_TIMEOUT_MS,
      onMsaCode: (data) => {
        emit({
          type: "msa_code",
          verification_uri: data.verification_uri,
          user_code: data.user_code,
          expires_in: data.expires_in,
        });
        // A device-code sign-in needs human time; push the connect watchdog out.
        connectDeadline = Date.now() + (data.expires_in + 30) * 1000;
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
  let connectDeadline = Date.now() + CONNECT_TIMEOUT_MS;
  let spawned = false;
  const watchdog = setInterval(() => {
    if (!spawned && Date.now() >= connectDeadline) {
      clearInterval(watchdog);
      emit({ type: "connection_failed", error: "Timed out before joining the world" });
      endProcess(1);
    }
  }, 1000);

  // Behavior tick.
  const tick = setInterval(() => {
    try {
      behavior.onTick();
    } catch (err) {
      emit({ type: "warning", message: `Behavior tick error: ${errMsg(err)}` });
    }
  }, 1000);

  const shutdown = (code: number) => {
    clearInterval(watchdog);
    clearInterval(tick);
    endProcess(code);
  };

  // --- Lifecycle events ---
  c.on("join", () => emit({ type: "login" }));

  c.on("spawn", () => {
    spawned = true;
    behavior.markSpawned();
    const profile = (client as unknown as { profile?: { name: string; uuid: string } }).profile;
    if (profile?.name) {
      emit({ type: "profile", username: profile.name, uuid: profile.uuid ?? "" });
    }
    emit({ type: "spawn" });
  });

  const onGone = (reason: string) => {
    emit({ type: "disconnect", reason: reason || null });
    shutdown(0);
  };
  c.on("disconnect", (packet: unknown) => onGone(reasonOf(packet)));
  c.on("kick", (packet: unknown) => onGone(reasonOf(packet)));
  c.on("close", () => {
    if (!exiting) onGone("Connection closed");
  });
  c.on("error", (err: unknown) => {
    emit({ type: "connection_failed", error: errMsg(err) });
    shutdown(1);
  });

  // --- World / telemetry packets (all defensive) ---
  c.on("start_game", (packet: unknown) => {
    try {
      const p = packet as { runtime_entity_id?: unknown; itemstates?: unknown };
      const id = toBigIntOrNull(p.runtime_entity_id);
      sender.setRuntimeEntityId(id);
      captureItemPalette(p.itemstates);
    } catch {
      /* ignore */
    }
  });

  // 1.21.60+ delivers the item palette in a separate item_registry packet.
  c.on("item_registry", (packet: unknown) => {
    try {
      captureItemPalette((packet as { itemstates?: unknown }).itemstates);
    } catch {
      /* ignore */
    }
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

  // --- Inventory ---
  c.on("container_open", () => behavior.setContainerOpen(true));
  c.on("container_close", () => behavior.setContainerOpen(false));
  c.on("inventory_content", (packet: unknown) => {
    try {
      handleInventoryContent(packet, behavior);
    } catch {
      /* ignore malformed inventory packet */
    }
  });

  // --- stdin command loop ---
  startCommandReader((cmd) => handleCommand(cmd, sender, behavior, c, shutdown));
}

function handleCommand(
  cmd: Command,
  sender: BotSender,
  behavior: BehaviorState,
  c: { close?: () => void; disconnect?: () => void },
  shutdown: (code: number) => void,
): void {
  switch (cmd.type) {
    case "chat":
      sender.send(cmd.text);
      break;
    case "configure":
      behavior.updateConfig(cmd);
      break;
    case "run_task":
      behavior.enqueueTask(cmd.text);
      break;
    case "query_balance":
      behavior.enqueueBalance(cmd.command);
      break;
    case "clean_spawner":
      behavior.enqueueCleanSpawner();
      break;
    case "request_inventory":
      behavior.emitInventory();
      break;
    case "move_item":
      behavior.enqueueMoveItem(cmd.from, cmd.to);
      break;
    case "drop_item":
      behavior.enqueueDropItem(cmd.slot);
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

/** Parse a Bedrock inventory_content packet into a player-inventory snapshot. */
function handleInventoryContent(packet: unknown, behavior: BehaviorState): void {
  const p = packet as { window_id?: unknown; input?: unknown[] };
  const items = (p.input ?? []).map(itemToSlot);
  const wid = p.window_id;
  const isPlayer = wid === 0 || wid === "inventory";
  const isArmor = wid === 120 || wid === "armor";
  const isOffhand = wid === 119 || wid === "offhand";

  if (isPlayer) {
    // Bedrock player container: slots 0-8 hotbar, 9-35 storage.
    const hotbar = items.slice(0, 9);
    const main = items.slice(9, 36);
    behavior.setPlayerInventory(pad(main, 27), pad(hotbar, 9));
    behavior.emitInventory();
  } else if (isArmor) {
    behavior.setArmor(pad(items.slice(0, 4), 4));
    behavior.emitInventory();
  } else if (isOffhand) {
    behavior.setOffhand(items[0] ?? null);
    behavior.emitInventory();
  }
}

function itemToSlot(raw: unknown): InventorySlot | null {
  const r = raw as { network_id?: number; count?: number; name?: string };
  const count = typeof r?.count === "number" ? r.count : 0;
  const networkId = typeof r?.network_id === "number" ? r.network_id : 0;
  if (!networkId || count <= 0) return null;
  // Prefer an explicit name; otherwise resolve the network id via the item
  // palette captured from start_game / item_registry, falling back to a raw id.
  const resolved = r.name || itemPalette.get(networkId);
  const id = resolved
    ? resolved.includes(":")
      ? resolved
      : `minecraft:${resolved}`
    : `bedrock:${networkId}`;
  return { id, count };
}

/** network/runtime id -> item name, captured from the server's item palette. */
const itemPalette = new Map<number, string>();

function captureItemPalette(states: unknown): void {
  if (!Array.isArray(states)) return;
  for (const s of states) {
    const st = s as { name?: string; runtime_id?: number };
    if (typeof st?.runtime_id === "number" && typeof st?.name === "string") {
      itemPalette.set(st.runtime_id, st.name);
    }
  }
}

function pad<T>(arr: (T | null)[], len: number): (T | null)[] {
  const out = arr.slice(0, len);
  while (out.length < len) out.push(null);
  return out;
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
