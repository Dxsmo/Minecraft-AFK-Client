/** Per-account cancellation scope and scheduler, shared by the backend
 * controllers and optional diagnostic CLI. All editions use one SoulFire JVM. */
import path from "node:path";
import { MinecraftDisconnected, retryEventStream, soulFireError, unavailableControlService } from "./errors.js";
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
import { SoulFireInventory } from "./inventory.js";

// Reserved by our pinned native extension, never a Minecraft inventory slot.
export const SELL_ALL_PLAYER_SLOTS = -1048576;

function streamRetryDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

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
  emit({ type: "behavior_log", message: "Anmeldung bestätigt; bereite Minecraft-Verbindung vor…" });
  const setting = async (namespace: string, key: string, value: string | number | boolean) => {
    await rpc.bot.updateBotConfigEntry({ ...ids, namespace, key, value: fromJson(ValueSchema, value) }, call());
  };
  // Node's existing supervisor owns exactly the configured reconnect policy.
  await setting("auto-reconnect", "enabled", false);
  await setting("auto-respawn", "enabled", false);
  await setting("client-settings", "render-distance", 2);
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
  emit({ type: "behavior_log", message: `Minecraft-Protokoll ausgewählt (${selected.displayName || selected.id}); bereite Client-Steuerung vor…` });

  let sneakCheck = 0;
  const inventory = new SoulFireInventory();
  let heldButton: string | undefined, heldCrouch: boolean | undefined, nativeSellConfig: string | undefined;
  let nativeSellEnabled = false, nextSellLease = 0, sellLeaseBusy = false;
  const renewSellLease = async () => {
    await rpc.bot.updateBotConfigEntry({ ...ids, namespace: "afk-service", key: "sell-lease-until", value: fromJson(ValueSchema, Date.now() + 15_000) }, { signal, timeoutMs: 3000 });
    nextSellLease = Date.now() + 5000;
  };
  const nativeSellPause = async (afterMs: number, resumeMs: number) => {
    const now = Date.now();
    await setting("afk-service", "sell-pause-from", resumeMs ? now + afterMs : 0);
    await setting("afk-service", "sell-pause-until", resumeMs ? now + resumeMs : 0);
  };
  const gateway: GameGateway = {
    nativeAutosell: true,
    suspendSell: async duration => { if (nativeSellEnabled) await setting("afk-service", "sell-manual-until", Date.now() + duration); },
    held: async cfg => {
      const button = (cfg.auto_button || "off").toUpperCase(), crouch = !!cfg.crouch_enabled;
      if (button !== heldButton) { await setting("afk-service", "auto-button", button); heldButton = button; }
      if (crouch !== heldCrouch) { await setting("afk-service", "crouch-enabled", crouch); heldCrouch = crouch; }
      const sellConfig = JSON.stringify({ enabled: !!cfg.autosell_enabled, intervalMs: Math.max(250, (cfg.autosell_interval_seconds ?? 60) * 1000), command: (cfg.autosell_command || "/sell").trim() });
      nativeSellEnabled = !!cfg.autosell_enabled;
      if (sellConfig !== nativeSellConfig) { await setting("afk-service", "native-auto-sell", sellConfig); nativeSellConfig = sellConfig; }
      if (nativeSellEnabled && Date.now() >= nextSellLease) await renewSellLease();
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
  await setting("afk-service", "sell-manual-until", 0);
  await nativeSellPause(config.autosell_pause_after_ms ?? 0, config.autosell_resume_after_ms ?? 0);
  let online = false, busy = false, statusBusy = false, heartbeatAt = 0, lastStatusAt = -Infinity, lastWarning = 0;
  let lastStartupState: BotRuntimeState | undefined;
  const startupStatus = (state: BotRuntimeState | undefined) => {
    if (online || state === lastStartupState) return;
    lastStartupState = state;
    const message = state === BotRuntimeState.QUEUED ? "Warte auf den Verbindungsstart im Bot-Dienst…"
      : state === BotRuntimeState.STARTING ? "Minecraft-Client wird gestartet…"
      : state === BotRuntimeState.RUNNING ? "Minecraft-Client gestartet; warte auf Serveranmeldung und Weltbeitritt…" : undefined;
    if (message) emit({ type: "behavior_log", message });
  };
  const spawned = async () => {
    if (online || signal.aborted) return;
    online = true;
    try { await behaviors.spawned(); }
    catch (error) { online = false; behaviors.joining(); throw error; }
    if (!signal.aborted) emit({ type: "spawn" });
  };
  let controlUnavailable = false;
  const controlRestored = () => {
    if (controlUnavailable) { controlUnavailable = false; emit({ type: "control_status", available: true }); }
  };
  let position: { x: number; y: number; z: number; dimension: string } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stream: Promise<void> | undefined;
  let wakeScheduler: (() => void) | undefined;
  let eventPending = false;
  let lastStreamWarning = -Infinity;
  try {
    stream = (async () => {
      let retryMs = 500;
      while (!signal.aborted) {
        try {
          for await (const frame of rpc.live.watchBotEvents({ ...ids, filter: { includeStateDeltas: true, includeInventory: true, includeChat: true, includeLifecycle: true }, heartbeatIntervalSeconds: 5 }, { signal, timeoutMs: 0 })) {
            retryMs = 500;
            const event = frame.event;
            if (event.case === "status") startupStatus(event.value.runtimeState);
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
              await spawned();
            }
            if (event.case === "stateDelta" && position) {
              const next = { ...position, ...Object.fromEntries(Object.entries(event.value).filter(([, value]) => value !== undefined)) };
              if (next.dimension !== position.dimension || Math.hypot(next.x - position.x, next.y - position.y, next.z - position.z) > 1) behaviors.transition();
              position = next;
            }
            if (event.case === "lifecycle") {
              if (event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_CONNECTED) emit({ type: "login" });
              if (event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_DISCONNECTED) throw new MinecraftDisconnected(event.value.message || "Minecraft-Verbindung beendet");
              if (event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_DIED) { inventory.reset(); behaviors.joining(); online = false; await rpc.live.respawn(ids, call()); }
              if (event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_RESPAWNED || event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_SPAWNED) {
                if (event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_RESPAWNED) online = false;
                await spawned();
              }
            }
            if (event.case === "status" && (event.value.runtimeState === BotRuntimeState.FAILED || event.value.runtimeState === BotRuntimeState.RETRYING)) throw new MinecraftDisconnected(event.value.lastError || "SoulFire-Verbindung fehlgeschlagen");
            if (event.case === "status" && online && event.value.runtimeState === BotRuntimeState.STOPPED) throw new MinecraftDisconnected("SoulFire-Bot wurde gestoppt (möglicher Neustart des gemeinsamen Dienstes)");
            // Game-state frames confirm activity; transport-only heartbeats do not
            // hide a frozen client from the existing online watchdog.
            if (online && ["snapshot", "stateDelta", "inventory"].includes(event.case ?? "") && Date.now() - heartbeatAt >= 5000) {
              controlRestored();
              heartbeatAt = Date.now(); emit({ type: "heartbeat" });
            }
          }
          if (!signal.aborted) throw new Error("SoulFire-Ereignisstream wurde beendet");
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof MinecraftDisconnected || !retryEventStream(error)) throw error;
          // Telemetry has its own transport lifetime. Keep the game connection,
          // native sale lease and independent health check alive while resubscribing.
          inventory.reset();
          if (Date.now() - lastStreamWarning >= 30_000) {
            lastStreamWarning = Date.now();
            emit({ type: "warning", message: `SoulFire-Ereignisstream unterbrochen: ${soulFireError(error)}; verbinde Ereignisstream erneut` });
          }
          await streamRetryDelay(retryMs, signal);
          retryMs = Math.min(retryMs * 2, 5000);
        }
      }
    })();
    void stream.catch(error => { if (!signal.aborted) { emit({ type: "connection_failed", error: soulFireError(error) }); abort.abort(); } });
    emit({ type: "behavior_log", message: `Starte Minecraft-Verbindung zu ${address}…` });
    await rpc.bot.setBotsDesiredState({ instanceId, botIds: [botId], desiredState: BotDesiredState.RUNNING }, call());
    const step = () => {
      if (signal.aborted) return;
      const now = Date.now();
      if (nativeSellEnabled && !sellLeaseBusy && now >= nextSellLease) {
        sellLeaseBusy = true; nextSellLease = now + 5000;
        void renewSellLease().catch(() => { nextSellLease = Date.now() + 1000; }).finally(() => { sellLeaseBusy = false; });
      }
      // Idle clients still need a health check, but its RPC cannot hold the
      // automation lock. Frequent game-state frames make this poll unnecessary.
      if (!statusBusy && now - heartbeatAt >= 5000 && now - lastStatusAt >= 5000) {
        statusBusy = true; lastStatusAt = now;
        void rpc.bot.getBotInfo(ids, { signal, timeoutMs: 3000 }).then(async state => {
          if (signal.aborted) return;
          controlRestored();
          startupStatus(state.status?.runtimeState);
          if (state.status?.runtimeState === BotRuntimeState.FAILED || state.status?.runtimeState === BotRuntimeState.RETRYING) {
            emit({ type: "connection_failed", error: state.status.lastError || "Minecraft-Verbindung fehlgeschlagen" }); abort.abort(); return;
          }
          if (state.status?.runtimeState === BotRuntimeState.STOPPED) {
            emit({ type: "connection_failed", error: "SoulFire-Bot wurde gestoppt (möglicher Neustart des gemeinsamen Dienstes)" }); abort.abort(); return;
          }
          // A stream outage/burst can lose the first snapshot and SPAWNED event.
          // A live player returned by the independent game-thread query also
          // proves world entry; otherwise the supervisor retries every 5 minutes.
          if (state.liveState && state.status?.runtimeState === BotRuntimeState.RUNNING) await spawned();
          if (online && state.liveState) { heartbeatAt = Date.now(); emit({ type: "heartbeat" }); }
        }).catch(error => {
          if (signal.aborted) return;
          if (unavailableControlService(error)) {
            controlUnavailable = true;
            // Renew only after an actual failed status request. A dead scheduler
            // cannot leave the supervisor's watchdog disabled indefinitely.
            emit({ type: "control_status", available: false, error: soulFireError(error) });
          } else if (!retryEventStream(error)) {
            emit({ type: "connection_failed", error: soulFireError(error) }); abort.abort();
          }
        })
          .finally(() => { statusBusy = false; });
      }
      if (busy) return;
      busy = true;
      void (async () => {
        while (queued.length) {
          const command = queued.shift()!;
          switch (command.type) {
            case "configure": await behaviors.configure(command); break;
            case "pause_autosell":
              behaviors.pause(command.autosell_pause_after_ms ?? 0, command.autosell_resume_after_ms ?? 0);
              await nativeSellPause(command.autosell_pause_after_ms ?? 0, command.autosell_resume_after_ms ?? 0); break;
            case "check_crouch": behaviors.checkSneak(); break;
            case "chat": behaviors.enqueue("chat", command.text); break;
            case "clean_spawner": behaviors.enqueue("clean_spawner"); break;
            case "read_sell_multipliers": behaviors.enqueue("read_sell_multipliers"); break;
          }
        }
        // Native selling and manual commands must keep working even when
        // inventory telemetry is dropped under load. The client owns the GUI.
        if (inventory.ready || gateway.nativeAutosell) await behaviors.tick();
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
    if (!signal.aborted) emit({ type: "connection_failed", error: soulFireError(error) });
    throw error;
  } finally {
    clearInterval(timer);
    wakeScheduler = undefined;
    abort.abort();
    await rpc.bot.setBotsDesiredState({ instanceId, botIds: [botId], desiredState: BotDesiredState.STOPPED }, { timeoutMs: 3000 }).catch(() => undefined);
    await stream?.catch(() => undefined);
  }
}
