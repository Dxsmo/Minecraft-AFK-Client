import mineflayer, { type Bot, type BotOptions } from "mineflayer";
import { mkdirSync } from "node:fs";
import { AutomationBehaviors, type BotOutput } from "../minecraft/behaviors.js";
import type { Config, Command } from "../bedrock-bot/protocol.js";
import { MineflayerGateway } from "./gateway.js";
import { selectJavaVersion } from "../minecraft/versions.js";
import { microsoftClientOptions } from "../minecraft/microsoftClient.js";

export interface MineflayerSession { bot: Bot; command(command: Command): void; stop(): void }

export function startMineflayer(config: Config, emit: BotOutput, ended: (code: number) => void): MineflayerSession {
  mkdirSync(config.cache_dir, { recursive: true, mode: 0o700 });
  const microsoft = config.auth_type === "microsoft";
  const options = {
    host: config.host, port: config.port || 25565,
    username: microsoft ? config.email || config.username : config.username,
    auth: microsoft ? "microsoft" : "offline", version: selectJavaVersion(config.version),
    profilesFolder: config.cache_dir, password: microsoft ? config.password || undefined : undefined,
    ...(microsoft ? microsoftClientOptions(config.cache_dir, "JAVA") : {}),
    viewDistance: "short", clientSettings: { viewDistance: 4 }, hideErrors: true, checkTimeoutInterval: 60_000,
    // Drop excessive physics catch-up after host contention instead of
    // sending a sudden movement burst that triggers server anti-cheat.
    maxCatchupTicks: 1,
    onMsaCode: (data: { verification_uri?: string; verificationUri?: string; user_code?: string; userCode?: string; expires_in?: number; expiresIn?: number }) => {
      emit({ type: "msa_code", verification_uri: data.verification_uri ?? data.verificationUri,
        user_code: data.user_code ?? data.userCode, expires_in: data.expires_in ?? data.expiresIn ?? 900 });
    },
  };
  const bot = mineflayer.createBot(options as unknown as BotOptions);
  const gateway = new MineflayerGateway(bot);
  const behaviors = new AutomationBehaviors(config, gateway, emit);
  behaviors.pause(config.autosell_pause_after_ms ?? 0, config.autosell_resume_after_ms ?? 0);
  let closed = false, spawned = false, busy = false, lastHeartbeat = 0, lastWarning = 0;
  let profileSent = false;
  const commands: Command[] = [];
  const profile = () => {
    if (profileSent || !bot.username) return;
    profileSent = true;
    emit({ type: "profile", username: bot.username, uuid: bot._client.uuid ?? "" });
  };
  const finish = (code: number, event?: Record<string, unknown>) => {
    if (closed) return;
    closed = true; clearInterval(timer); commands.length = 0; behaviors.dispose(); gateway.dispose();
    if (event) emit(event);
    try { bot.end("AFK client stopped"); } finally { ended(code); }
  };
  const warn = (error: unknown) => {
    if (!closed && Date.now() - lastWarning >= 30_000) {
      lastWarning = Date.now(); emit({ type: "warning", message: `Mineflayer: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  const worldReady = () => {
    if (closed || spawned) return;
    profile(); spawned = true;
    void behaviors.spawned().then(() => { if (!closed && spawned) emit({ type: "spawn" }); }).catch(warn);
  };
  const timer = setInterval(() => {
    if (closed || busy) return;
    busy = true;
    void (async () => {
      while (commands.length && !closed) {
        const cmd = commands.shift()!;
        switch (cmd.type) {
          case "configure": await behaviors.configure(cmd); break;
          case "pause_autosell": behaviors.pause(cmd.autosell_pause_after_ms, cmd.autosell_resume_after_ms); break;
          case "check_crouch": behaviors.checkSneak(); break;
          case "chat": behaviors.enqueue("chat", cmd.text); break;
          case "clean_spawner": case "read_sell_multipliers": behaviors.enqueue(cmd.type); break;
        }
      }
      if (closed || !spawned) return;
      if (behaviors.needsTick()) await behaviors.tick();
      if (closed) return;
      // Heartbeats confirm a completed behavior pass, not just a live timer.
      if (Date.now() - lastHeartbeat >= 15_000) { lastHeartbeat = Date.now(); emit({ type: "heartbeat" }); }
      if (behaviors.ownsInteraction || bot.currentWindow) gateway.suspendButton();
      else void gateway.tickButton().catch(warn);
    })().catch(warn).finally(() => { busy = false; });
  }, 50);

  bot._client.on("session", profile);
  bot._client.on("state", state => {
    if (state !== "configuration" || closed) return;
    // Brand is normally sent by Mineflayer only after the play login. Some
    // proxies wait for it before completing configuration, including transfers.
    queueMicrotask(() => {
      if (closed || bot._client.state !== "configuration") return;
      try {
        bot._client.registerChannel("minecraft:brand", ["string", []]);
        bot._client.writeChannel("minecraft:brand", "vanilla");
      } catch (error) { warn(error); }
    });
  });
  bot.on("login", () => { profile(); spawned = false; behaviors.joining(); gateway.transition(); emit({ type: "login" }); });
  bot.on("spawn", worldReady);
  bot.on("respawn", () => { spawned = false; behaviors.joining(); gateway.transition(); });
  bot.on("forcedMove", () => {
    if (spawned) { behaviors.transition(); gateway.transition(); }
    else {
      // Some proxies never send update_health, which Mineflayer otherwise
      // requires for its spawn event. An accepted play-state position is
      // independent evidence of world entry and also occurs after transfers.
      if (bot.supportFeature("sendsPlayerLoadedPacket")) bot._client.write("player_loaded", {});
      worldReady();
    }
  });
  bot.on("death", () => { spawned = false; behaviors.joining(); });
  bot.on("message", (message, _position, sender?: string) => {
    const text = message.toString();
    const name = sender ? bot.players?.[sender]?.username ?? sender : null;
    behaviors.onChat(name, text); emit({ type: "chat", sender: name, message: text });
  });
  bot.on("resourcePack", () => {
    // The plugin already accepts configuration-phase requests itself.
    // Wait until its listener stored the current pack UUID/hash.
    queueMicrotask(() => { if (!closed && bot._client.state === "play") bot.acceptResourcePack(); });
  });
  bot.on("kicked", reason => finish(0, { type: "disconnect", reason: typeof reason === "string" ? reason : JSON.stringify(reason) }));
  bot.on("end", reason => finish(0, { type: "disconnect", reason: String(reason || "Connection closed") }));
  bot.on("error", error => finish(1, { type: "connection_failed", error: error.message }));

  return { bot, stop: () => finish(0), command: command => {
    if (closed) return;
    if (command.type === "disconnect") { finish(0); return; }
    if (commands.length >= 64) { emit({ type: "warning", message: "Befehlswarteschlange voll" }); return; }
    commands.push(command);
  } };
}
