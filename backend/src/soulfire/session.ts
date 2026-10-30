/** Per-account cancellation scope and scheduler, shared by the backend
 * controllers and optional diagnostic CLI. All editions use one SoulFire JVM. */
import path from "node:path";
import { fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { AccountTypeCredentials } from "@soulfiremc/sdk/generated/soulfire/common_pb";
import { BotDesiredState, BotRuntimeState, ClickType } from "@soulfiremc/sdk/generated/soulfire/bot_pb";
import { QuerySort } from "@soulfiremc/sdk/generated/soulfire/world_pb";
import { BotActionStatus, BotLifecycleKind, Hand } from "@soulfiremc/sdk/generated/soulfire/bot_live_pb";
import { protocolOptions, selectProtocol, javaServerProtocol } from "./versions.js";
import { soulFireInstanceName } from "./instanceName.js";
import { soulFireRpc } from "./rpc.js";
import { authenticate, isRejectedMicrosoftLogin, readRemoteAccount, writePrivateJson, type Edition } from "./auth.js";
import { SoulFireBehaviors, type BehaviorConfig, type GameGateway, type BotOutput } from "./behaviors.js";
import { registerRemoteControl } from "./remoteState.js";
import { SoulFireInventory } from "./inventory.js";

// Reserved by our pinned native extension, never a Minecraft inventory slot.
export const SELL_ALL_PLAYER_SLOTS = -1048576;

export type SoulFireConfig = BehaviorConfig & { host: string; port: number; username: string; auth_type: string; email?: string; edition: Edition;
  cache_dir: string; account_id?: string; version?: string; autosell_pause_after_ms?: number; autosell_resume_after_ms?: number };

export async function runSoulFire(config: SoulFireConfig, emit: BotOutput, abort: AbortController, queued: Record<string, any>[]): Promise<void> {
  const rpc = soulFireRpc();
  const signal = abort.signal;
  const call = () => ({ signal, timeoutMs: 15_000 });
  const accountKey = config.account_id || path.basename(config.cache_dir);
  const instance = await rpc.instance.getOrCreateInstance({ name: soulFireInstanceName(accountKey) }, call());
  const instanceId = instance.id;
  const address = `${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`;
  await rpc.instance.updateInstanceConfigEntry({ id: instanceId, namespace: "bot", key: "address", value: fromJson(ValueSchema, address) }, call());
  let info = await rpc.instance.getInstanceInfo({ id: instanceId }, call());
  if (info.result.case !== "info") throw new Error("SoulFire hat keine Instanz-Konfiguration geliefert");
  const previous = await readRemoteAccount(config.cache_dir);
  let account = previous?.instanceId === instanceId ? info.result.value.config?.accounts.find(a => a.profileId === previous.botId) : undefined;
  if (account && config.auth_type !== "offline") {
    try {
      const refreshed = await rpc.auth.refresh({ instanceId, account }, { signal, timeoutMs: 120_000 });
      if (!refreshed.account) throw new Error("Microsoft-Account konnte nicht aktualisiert werden");
      account = refreshed.account;
    } catch (error) {
      // An unavailable/overloaded RPC or auth server does not revoke a login.
      if (signal.aborted || !isRejectedMicrosoftLogin(error)) throw error;
      account = undefined;
    }
  }
  if (!account) {
    if (config.auth_type === "offline") {
      for await (const result of rpc.auth.loginCredentials({ instanceId, service: AccountTypeCredentials.OFFLINE, payload: [config.username] }, { signal, timeoutMs: 30_000 })) {
        if (result.data.case === "oneSuccess") account = result.data.value.account;
      }
      if (!account) throw new Error("Offline-Account konnte nicht angelegt werden");
    } else {
      account = await authenticate(rpc, { instanceId, edition: config.edition, cacheDir: config.cache_dir, email: config.email || null, signal,
        onCode: code => emit({ type: "msa_code", ...code }),
        onMigrationFailure: () => emit({ type: "warning", message: "Die gespeicherte Microsoft-Anmeldung wurde abgelehnt. Bitte einmal neu anmelden; vorhandene Caches bleiben erhalten." }),
      });
    }
  }
  // Each website account owns one instance. Replace atomically so refreshes
  // and retries cannot append duplicate copies of the same game account.
  await rpc.instance.replaceInstanceAccounts({ id: instanceId, accounts: [account] }, call());
  const botId = account.profileId;
  const ids = { instanceId, botId };
  await writePrivateJson(path.join(config.cache_dir, "soulfire.json"), ids);
  emit({ type: "profile", username: account.lastKnownName, uuid: botId });
  const setting = async (namespace: string, key: string, value: string | number | boolean) => {
    await rpc.bot.updateBotConfigEntry({ ...ids, namespace, key, value: fromJson(ValueSchema, value) }, call());
  };
  // Node's existing supervisor owns exactly the configured reconnect policy.
  await setting("auto-reconnect", "enabled", false);
  await setting("auto-respawn", "enabled", false);
  await setting("afk-service", "remote-control", false);
  await setting("client-settings", "render-distance", 6);
  await setting("bot", "restore-on-reboot", false);
  const versions = await protocolOptions(rpc, instanceId);
  const advertised = config.edition === "JAVA" && !config.version
    ? await javaServerProtocol(config.host, config.port).catch(() => undefined) : undefined;
  let requested = config.version || "";
  if (config.edition === "BEDROCK" && requested && !versions.some(v => v.displayName === `Bedrock ${requested}`)) {
    // The former engine's pinned codec is unavailable in ViaBedrock. Keep the
    // DB preference and explicitly report the supported replacement in use.
    emit({ type: "warning", message: `Die bisherige Bedrock-Version ${requested} ist in SoulFire nicht verfügbar; verwende ${versions.find(v => v.displayName.startsWith("Bedrock "))?.displayName || "Auto"}.` });
    requested = "";
  }
  const selected = selectProtocol(versions, config.edition, requested, advertised);
  await setting("bot", "protocol-version", selected.id);

  let sneakCheck = 0;
  const inventory = new SoulFireInventory();
  let heldButton: string | undefined, heldCrouch: boolean | undefined;
  const gateway: GameGateway = {
    remote: async active => {
      await setting("afk-service", "remote-control", active);
      heldButton = undefined; heldCrouch = undefined;
    },
    held: async cfg => {
      const button = (cfg.auto_button || "off").toUpperCase(), crouch = !!cfg.crouch_enabled;
      if (button !== heldButton) { await setting("afk-service", "auto-button", button); heldButton = button; }
      if (crouch !== heldCrouch) { await setting("afk-service", "crouch-enabled", crouch); heldCrouch = crouch; }
    },
    sneak: async () => { await setting("afk-service", "sneak-check", ++sneakCheck); },
    chat: async message => { const result = await rpc.live.sendChat({ ...ids, message }, call()); if (result.result?.status !== BotActionStatus.COMPLETED) throw new Error("Command wurde nicht ausgeführt"); },
    inventory: async () => inventory.read(),
    click: async (menu, slot, action) => {
      const result = await rpc.bot.clickInventorySlot({ ...ids, expectedMenuId: menu, slot,
        clickType: action === "transfer" ? ClickType.SHIFT_LEFT_CLICK : action === "drop" ? ClickType.DROP_ALL : ClickType.LEFT_CLICK }, call());
      if (!result.success) throw new Error(result.error || "Inventaraktion abgelehnt");
    },
    transferAll: async menu => {
      const result = await rpc.bot.clickInventorySlot({ ...ids, expectedMenuId: menu, slot: SELL_ALL_PLAYER_SLOTS,
        clickType: ClickType.SHIFT_LEFT_CLICK }, call());
      if (!result.success) throw new Error(result.error || "Inventaraktion abgelehnt");
    },
    close: async menu => {
      try { await rpc.bot.closeContainer({ ...ids, expectedMenuId: menu }, call()); }
      catch (error) {
        // The server can close/replace the menu before its next stream frame.
        // Never close that replacement, or let this race discard a command.
        if (ConnectError.from(error).code !== Code.Aborted) throw error;
      }
    },
    openSpawner: async crouch => {
      const player = await rpc.world.getPlayerSnapshot(ids, call());
      if (!player.player?.position) return false;
      const found = await rpc.world.queryBlocks({ ...ids,
        region: { region: { case: "sphere", value: { center: player.player.position, radius: 4.5 } } },
        selector: { blockIds: ["minecraft:spawner", "minecraft:trial_spawner"], requireLineOfSight: true },
        sort: QuerySort.NEAREST, pageSize: 1,
      }, call());
      const position = found.blocks[0]?.position;
      if (!position) return false;
      const origin = player.player.position;
      const eyeHeight = crouch || /crouch|sneak/i.test(player.player.pose) ? 1.27 : 1.62;
      const hit = await rpc.world.raycast({ ...ids, maximumDistance: 4.5, includeEntities: false,
        direction: { x: position.x + 0.5 - origin.x, y: position.y + 0.5 - origin.y - eyeHeight, z: position.z + 0.5 - origin.z },
      }, call());
      const target = hit.block?.position;
      if (!hit.blockFace || !target || target.x !== position.x || target.y !== position.y || target.z !== position.z) return false;
      const previousMenu = inventory.read().menuId;
      const interaction = await rpc.live.interactBlock({ ...ids, position, face: hit.blockFace, hand: Hand.MAIN, sneaking: crouch }, call());
      // A plugin-owned spawner GUI can open after vanilla reports PASS. The
      // packet was sent; the actual new container is the authoritative reply.
      return interaction.result?.status === BotActionStatus.COMPLETED || await inventory.waitForContainer(previousMenu, signal);
    },
  };
  const behaviors = new SoulFireBehaviors(config, gateway, emit);
  behaviors.pause(config.autosell_pause_after_ms ?? 0, config.autosell_resume_after_ms ?? 0);
  await gateway.held(config);
  const unregisterRemote = registerRemoteControl(accountKey, active => behaviors.remote(active));
  let online = false, busy = false, statusBusy = false, heartbeatAt = 0, lastStatusAt = -Infinity, lastWarning = 0;
  let position: { x: number; y: number; z: number; dimension: string } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stream: Promise<void> | undefined;
  let wakeScheduler: (() => void) | undefined;
  let eventPending = false;
  try {
    stream = (async () => {
      for await (const frame of rpc.live.watchBotEvents({ ...ids, filter: { includeStateDeltas: true, includeInventory: true, includeChat: true, includeLifecycle: true }, heartbeatIntervalSeconds: 5 }, { signal, timeoutMs: 0 })) {
        const event = frame.event;
        // Dropped telemetry is not a teleport. Pause only until the fresh
        // inventory snapshot arrives, then reconcile existing menu ownership.
        // Resetting automation here imposed another 2s delay on every burst
        // of pickups/sales, and could postpone AutoSell indefinitely.
        if (event.case === "resyncRequired") inventory.reset();
        if (event.case === "inventory" && event.value.state) { inventory.update(event.value.state); wakeScheduler?.(); }
        if (event.case === "chat") { emit({ type: "chat", sender: event.value.senderName || null, message: event.value.plainText }); behaviors.onChat(event.value.senderName || null, event.value.plainText); wakeScheduler?.(); }
        if (event.case === "snapshot") {
          if (position && (position.dimension !== event.value.dimension || Math.hypot(position.x - event.value.x, position.y - event.value.y, position.z - event.value.z) > 1)) behaviors.transition();
          position = event.value;
          if (!online) { online = true; await behaviors.spawned(); emit({ type: "spawn" }); }
        }
        if (event.case === "stateDelta" && position) {
          const next = { ...position, ...Object.fromEntries(Object.entries(event.value).filter(([, value]) => value !== undefined)) };
          if (next.dimension !== position.dimension || Math.hypot(next.x - position.x, next.y - position.y, next.z - position.z) > 1) behaviors.transition();
          position = next;
        }
        if (event.case === "lifecycle") {
          if (event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_CONNECTED) emit({ type: "login" });
          if (event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_DISCONNECTED) throw new Error(event.value.message || "Minecraft-Verbindung beendet");
          if (event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_DIED) { inventory.reset(); behaviors.joining(); online = false; await rpc.live.respawn(ids, call()); }
          if (event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_RESPAWNED || event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_SPAWNED) {
            if (!online || event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_RESPAWNED) { online = true; await behaviors.spawned(); emit({ type: "spawn" }); }
          }
        }
        if (event.case === "status" && (event.value.runtimeState === BotRuntimeState.FAILED || event.value.runtimeState === BotRuntimeState.RETRYING)) throw new Error(event.value.lastError || "SoulFire-Verbindung fehlgeschlagen");
        // Game-state frames confirm activity; transport-only heartbeats do not
        // hide a frozen client from the existing online watchdog.
        if (online && ["snapshot", "stateDelta", "inventory"].includes(event.case ?? "") && Date.now() - heartbeatAt >= 5000) {
          heartbeatAt = Date.now(); emit({ type: "heartbeat" });
        }
      }
      if (!signal.aborted) throw new Error("SoulFire-Ereignisstream wurde beendet");
    })();
    void stream.catch(error => { if (!signal.aborted) { emit({ type: "connection_failed", error: error instanceof Error ? error.message : "SoulFire-Ereignisstream beendet" }); abort.abort(); } });
    await rpc.bot.setBotsDesiredState({ instanceId, botIds: [botId], desiredState: BotDesiredState.RUNNING }, call());
    const step = () => {
      if (signal.aborted) return;
      const now = Date.now();
      // Idle clients still need a health check, but its RPC cannot hold the
      // automation lock. Frequent game-state frames make this poll unnecessary.
      if (!statusBusy && now - heartbeatAt >= 5000 && now - lastStatusAt >= 5000) {
        statusBusy = true; lastStatusAt = now;
        void rpc.bot.getBotInfo(ids, { signal, timeoutMs: 3000 }).then(state => {
          if (signal.aborted) return;
          if (state.status?.runtimeState === BotRuntimeState.FAILED || state.status?.runtimeState === BotRuntimeState.RETRYING) {
            emit({ type: "connection_failed", error: state.status.lastError || "Minecraft-Verbindung fehlgeschlagen" }); abort.abort(); return;
          }
          if (online && state.liveState) { heartbeatAt = Date.now(); emit({ type: "heartbeat" }); }
        }).catch(() => { /* Stream failures and the online watchdog handle unavailable clients. */ })
          .finally(() => { statusBusy = false; });
      }
      if (busy) return;
      busy = true;
      void (async () => {
        while (queued.length) {
          const command = queued.shift()!;
          switch (command.type) {
            case "configure": await behaviors.configure(command); break;
            case "pause_autosell": behaviors.pause(command.autosell_pause_after_ms ?? 0, command.autosell_resume_after_ms ?? 0); break;
            case "check_crouch": behaviors.checkSneak(); break;
            case "chat": behaviors.enqueue("chat", command.text); break;
            case "clean_spawner": behaviors.enqueue("clean_spawner"); break;
            case "read_sell_multipliers": behaviors.enqueue("read_sell_multipliers"); break;
          }
        }
        if (inventory.ready) await behaviors.tick();
      })().catch(error => {
        if (!signal.aborted && Date.now() - lastWarning >= 30_000) { lastWarning = Date.now(); emit({ type: "warning", message: error instanceof Error ? error.message : "SoulFire-Aktion fehlgeschlagen" }); }
      }).finally(() => {
        busy = false;
        // Transfer confirmations continue the sale without 100ms per stack.
        if (eventPending && !signal.aborted) { eventPending = false; queueMicrotask(() => wakeScheduler?.()); }
      });
    };
    wakeScheduler = () => { if (busy) eventPending = true; else step(); };
    timer = setInterval(step, 100);
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
  } catch (error) {
    if (!signal.aborted) emit({ type: "connection_failed", error: error instanceof Error ? error.message : "SoulFire-Verbindung fehlgeschlagen" });
    throw error;
  } finally {
    unregisterRemote();
    clearInterval(timer);
    wakeScheduler = undefined;
    abort.abort();
    await rpc.bot.setBotsDesiredState({ instanceId, botIds: [botId], desiredState: BotDesiredState.STOPPED }, { timeoutMs: 3000 }).catch(() => undefined);
    await stream?.catch(() => undefined);
  }
}
