/** Per-account cancellation scope and scheduler, shared by the backend
 * controllers and optional diagnostic CLI. All editions use one SoulFire JVM. */
import path from "node:path";
import { fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { AccountTypeCredentials } from "@soulfiremc/sdk/generated/soulfire/common_pb";
import { BotDesiredState, BotRuntimeState, ClickType } from "@soulfiremc/sdk/generated/soulfire/bot_pb";
import { QuerySort } from "@soulfiremc/sdk/generated/soulfire/world_pb";
import { BotActionStatus, BotLifecycleKind } from "@soulfiremc/sdk/generated/soulfire/bot_live_pb";
import { protocolOptions, selectProtocol, javaServerProtocol } from "./versions.js";
import { soulFireInstanceName } from "./instanceName.js";
import { soulFireRpc } from "./rpc.js";
import { authenticate, readRemoteAccount, writePrivateJson, type Edition } from "./auth.js";
import { SoulFireBehaviors, type BehaviorConfig, type GameGateway, type GameInventory, type BotOutput } from "./behaviors.js";

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
    } catch (error) { if (signal.aborted) throw error; account = undefined; }
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
  const gateway: GameGateway = {
    held: async cfg => { await setting("afk-service", "auto-button", (cfg.auto_button || "off").toUpperCase()); await setting("afk-service", "crouch-enabled", !!cfg.crouch_enabled); },
    sneak: async () => { await setting("afk-service", "sneak-check", ++sneakCheck); },
    chat: async message => { const result = await rpc.live.sendChat({ ...ids, message }, call()); if (result.result?.status !== BotActionStatus.COMPLETED) throw new Error("Command wurde nicht ausgeführt"); },
    inventory: async () => {
      const state = await rpc.bot.getInventoryState(ids, call());
      const container = state.layout?.regions.filter(r => r.id === "container") ?? [];
      const player = state.layout?.regions.filter(r => /player_inventory|player_hotbar/.test(r.id)) ?? [];
      const indices = (regions: typeof container) => regions.flatMap(r => Array.from({ length: r.slotCount }, (_, i) => r.startIndex + i));
      return { menuId: state.menuId, title: state.layout?.title ?? "", containerSlots: indices(container), playerSlots: indices(player),
        slots: state.slots.map(slot => ({ ...slot, displayName: slot.displayName || "" })) } satisfies GameInventory;
    },
    click: async (menu, slot, action) => {
      const result = await rpc.bot.clickInventorySlot({ ...ids, expectedMenuId: menu, slot,
        clickType: action === "transfer" ? ClickType.SHIFT_LEFT_CLICK : action === "drop" ? ClickType.DROP_ALL : ClickType.LEFT_CLICK }, call());
      if (!result.success) throw new Error(result.error || "Inventaraktion abgelehnt");
    },
    close: async menu => { await rpc.bot.closeContainer({ ...ids, expectedMenuId: menu }, call()); },
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
      const interaction = await rpc.live.interactBlock({ ...ids, position, sneaking: crouch }, call());
      return interaction.result?.status === BotActionStatus.COMPLETED;
    },
  };
  const behaviors = new SoulFireBehaviors(config, gateway, emit);
  behaviors.pause(config.autosell_pause_after_ms ?? 0, config.autosell_resume_after_ms ?? 0);
  await gateway.held(config);
  let online = false, busy = false, heartbeatAt = 0, lastWarning = 0;
  let position: { x: number; y: number; z: number; dimension: string } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stream: Promise<void> | undefined;
  try {
    stream = (async () => {
      for await (const frame of rpc.live.watchBotEvents({ ...ids, filter: { includeStateDeltas: true, includeChat: true, includeLifecycle: true }, heartbeatIntervalSeconds: 5 }, { signal, timeoutMs: 0 })) {
        const event = frame.event;
        if (event.case === "chat") { emit({ type: "chat", sender: event.value.senderName || null, message: event.value.plainText }); behaviors.onChat(event.value.senderName || null, event.value.plainText); }
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
          if (event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_DIED) { behaviors.joining(); online = false; await rpc.live.respawn(ids, call()); }
          if (event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_RESPAWNED || event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_SPAWNED) {
            if (!online || event.value.kind === BotLifecycleKind.BOT_LIFECYCLE_RESPAWNED) { online = true; await behaviors.spawned(); emit({ type: "spawn" }); }
          }
        }
        if (event.case === "status" && (event.value.runtimeState === BotRuntimeState.FAILED || event.value.runtimeState === BotRuntimeState.RETRYING)) throw new Error(event.value.lastError || "SoulFire-Verbindung fehlgeschlagen");
      }
    })();
    void stream.catch(error => { if (!signal.aborted) { emit({ type: "connection_failed", error: error instanceof Error ? error.message : "SoulFire-Ereignisstream beendet" }); abort.abort(); } });
    await rpc.bot.setBotsDesiredState({ instanceId, botIds: [botId], desiredState: BotDesiredState.RUNNING }, call());
    timer = setInterval(() => {
      if (busy || signal.aborted) return;
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
        if (Date.now() - heartbeatAt >= 5000) {
          const state = await rpc.bot.getBotInfo(ids, call());
          if (state.status?.runtimeState === BotRuntimeState.FAILED || state.status?.runtimeState === BotRuntimeState.RETRYING) { emit({ type: "connection_failed", error: state.status.lastError || "Minecraft-Verbindung fehlgeschlagen" }); abort.abort(); return; }
          if (state.liveState) { if (!online) { online = true; await behaviors.spawned(); emit({ type: "spawn" }); } emit({ type: "heartbeat" }); }
          heartbeatAt = Date.now();
        }
        await behaviors.tick();
      })().catch(error => {
        if (!signal.aborted && Date.now() - lastWarning >= 30_000) { lastWarning = Date.now(); emit({ type: "warning", message: error instanceof Error ? error.message : "SoulFire-Aktion fehlgeschlagen" }); }
      }).finally(() => { busy = false; });
    }, 100);
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
  } catch (error) {
    if (!signal.aborted) emit({ type: "connection_failed", error: error instanceof Error ? error.message : "SoulFire-Verbindung fehlgeschlagen" });
    throw error;
  } finally {
    clearInterval(timer);
    abort.abort();
    await rpc.bot.setBotsDesiredState({ instanceId, botIds: [botId], desiredState: BotDesiredState.STOPPED }, { timeoutMs: 3000 }).catch(() => undefined);
    await stream?.catch(() => undefined);
  }
}
