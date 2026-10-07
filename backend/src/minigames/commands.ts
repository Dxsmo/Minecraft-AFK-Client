import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../database/prisma.js";
import {
  ensure,
  generateCode,
  member,
  type Event,
  type Lobby,
} from "./protocol.js";
import { engine, validateConfig } from "./games/index.js";
import { prepareRound } from "./rounds.js";
import type { Audit } from "./repository.js";
import type { MinigameService } from "./service.js";

export async function handleCommand(
  service: MinigameService,
  uuid: string,
  event: Event,
  connectionId?: string,
) {
  return service.serialize(async () => {
    const client = service.clients.get(uuid);
    ensure(
      client && (!connectionId || client.connectionId === connectionId),
      "NOT_CONNECTED",
    );
    client.lastSeen = service.now();
    ensure(Math.abs(event.timestamp - service.now()) <= 30000, "STALE_EVENT");
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          ...event,
          sequence: undefined,
          timestamp: undefined,
        }),
      )
      .digest("hex");
    const receipt = await service.repository.receipt(event.requestId);
    if (receipt) {
      ensure(
        receipt.playerUuid === uuid && receipt.hash === hash,
        "IDEMPOTENCY_CONFLICT",
      );
      client.send({ type: "ACK", requestId: event.requestId });
      service.snapshot(uuid);
      return;
    }
    const backup = structuredClone([...service.lobbies.entries()]),
      invites = structuredClone([...service.invites.entries()]);
    let l = service.find(uuid);
    const events: Audit[] = [];
    const notifications: Array<() => void> = [];
    const audit = (type: string, details?: Record<string, unknown>) =>
      events.push({ type, playerUuid: uuid, details });
    event = { ...event, timestamp: service.now() };
    try {
      switch (event.type) {
        case "HEARTBEAT":
          client.send({ type: "HEARTBEAT", serverTime: service.now() });
          return;
        case "SNAPSHOT":
          service.snapshot(uuid);
          return;
        case "STREAMER":
          client.hello.streamerMode = event.enabled;
          if (l) member(l, uuid).streamerMode = event.enabled;
          await prisma.minigamePlayer.update({
            where: { uuid },
            data: { streamerMode: event.enabled },
          });
          break;
        case "CREATE": {
          ensure(!l, "ALREADY_IN_LOBBY");
          service.limit(uuid, "create", 5);
          const game = event.game;
          const settings = validateConfig(event.game, {
            ...(service.content.find(
              (x) => x.kind === "settings" && x.id === game && x.enabled,
            )?.data ?? {}),
            ...event.config,
          });
          if (event.game === "photo_hunt")
            ensure(
              client.hello.capabilities.includes("photo_consent"),
              "PHOTO_CONSENT_REQUIRED",
            );
          let code = generateCode();
          while (
            [...service.lobbies.values()].some((x) => x.code === code) ||
            (await prisma.minigameLobby.findUnique({ where: { code } }))
          )
            code = generateCode();
          l = {
            id: randomUUID(),
            code,
            host: uuid,
            game: event.game,
            network: client.hello.logicalServerNetwork,
            state: "LOBBY",
            config: settings,
            createdAt: service.now(),
            revision: 0,
            members: [service.newMember(client.hello)],
            bans: [],
            kicks: {},
            data: {},
            winners: [],
            matchScores: {},
            round: 1,
          };
          service.lobbies.set(l.id, l);
          audit("LOBBY_CREATED");
          break;
        }
        case "JOIN": {
          service.limit(uuid, "join", 10);
          ensure(!l, "ALREADY_IN_LOBBY");
          const code = event.code;
          l = [...service.lobbies.values()].find(
            (x) => x.code === code && x.state === "LOBBY",
          );
          ensure(l, "LOBBY_NOT_FOUND");
          service.join(l, client.hello);
          audit("PLAYER_JOINED");
          break;
        }
        case "INVITE_REPLY": {
          const invite = service.invites.get(event.inviteId);
          ensure(
            invite &&
              invite.target === uuid &&
              service.now() - invite.createdAt < 120000,
            "INVITE_EXPIRED",
          );
          service.invites.delete(invite.id);
          if (!event.accept) return;
          ensure(!l, "ALREADY_IN_LOBBY");
          l = service.lobbies.get(invite.lobby);
          ensure(l && l.state === "LOBBY", "LOBBY_NOT_FOUND");
          service.join(l, client.hello);
          audit("PLAYER_JOINED");
          break;
        }
        case "CONNECTION":
          if (l) {
            const m = member(l, uuid);
            if (event.state === "CONNECTED") service.reconnected(l, m);
            else if (m.connection !== "TRANSFERRING") {
              m.connection = "TRANSFERRING";
              m.transferringUntil = service.now() + 10000;
              if (m.status === "ACTIVE") m.status = "TRANSFERRING";
            }
            audit("CONNECTION_CHANGED");
          }
          break;
        case "INVITE_LIST": {
          ensure(l, "NOT_IN_LOBBY");
          ensure(l.host === uuid, "HOST_REQUIRED");
          client.send({
            type: "INVITE_LIST",
            players: [...service.clients.values()]
              .filter(
                (c) =>
                  c.hello.logicalServerNetwork === l!.network &&
                  !service.find(c.hello.playerUuid),
              )
              .map((c) => ({
                uuid: c.hello.playerUuid,
                name: c.hello.playerName,
              })),
          });
          return;
        }
        default: {
          ensure(l, "NOT_IN_LOBBY");
          const m = member(l, uuid);
          if (["START", "DISBAND", "KICK", "INVITE"].includes(event.type))
            ensure(l.host === uuid, "HOST_REQUIRED");
          switch (event.type) {
            case "SCREEN":
              m.screenClosedAt = event.open ? undefined : service.now();
              audit(event.open ? "SCREEN_OPENED" : "SCREEN_CLOSED");
              break;
            case "READY":
              ensure(l.state === "LOBBY", "NOT_IN_LOBBY_PHASE");
              m.ready = event.ready;
              audit("READY_CHANGED", { ready: m.ready });
              break;
            case "DISBAND":
              l.state = "FINISHED";
              audit("LOBBY_DISBANDED");
              break;
            case "LEAVE":
              if (l.host === uuid) l.state = "FINISHED";
              else service.remove(l, m);
              notifications.push(() => client.send({ type: "LEFT" }));
              audit("PLAYER_LEFT");
              break;
            case "KICK": {
              const t = member(l, event.target);
              ensure(t.uuid !== uuid, "CANNOT_KICK_HOST");
              l.kicks[t.uuid] = (l.kicks[t.uuid] ?? 0) + 1;
              const ban = event.ban || l.kicks[t.uuid] >= 2;
              if (ban) l.bans.push(t.uuid);
              service.remove(l, t);
              notifications.push(() =>
                service.clients
                  .get(t.uuid)
                  ?.send({ type: "KICKED", banned: ban }),
              );
              audit(ban ? "PLAYER_BANNED" : "PLAYER_KICKED", {
                target: t.uuid,
              });
              break;
            }
            case "INVITE": {
              ensure(l.state === "LOBBY", "NOT_IN_LOBBY_PHASE");
              const target = service.clients.get(event.target);
              ensure(
                target &&
                  target.hello.logicalServerNetwork === l.network &&
                  !service.find(event.target) &&
                  !l.bans.includes(event.target),
                "INVITE_TARGET_UNAVAILABLE",
              );
              const key = uuid + ":" + event.target;
              ensure(
                service.now() - (service.inviteTimes.get(key) ?? -Infinity) >=
                  60000,
                "INVITE_COOLDOWN",
              );
              service.inviteTimes.set(key, service.now());
              const invite = {
                id: randomUUID(),
                lobby: l.id,
                host: uuid,
                target: event.target,
                createdAt: service.now(),
              };
              service.invites.set(invite.id, invite);
              notifications.push(() =>
                target.send({
                  type: "INVITE",
                  inviteId: invite.id,
                  host: m.name,
                  game: l!.game,
                }),
              );
              audit("INVITE_SENT", { target: event.target });
              break;
            }
            case "START":
              ensure(l.state === "LOBBY", "ALREADY_STARTED");
              ensure(
                l.members.length >= engine(l.game).minPlayers,
                "NOT_ENOUGH_PLAYERS",
              );
              ensure(
                l.members.every((m) => m.connection === "CONNECTED"),
                "PLAYERS_NOT_CONNECTED",
              );
              l.state = "PREPARING";
              l.preparingAt = service.now();
              for (const m of l.members) m.inventoryAt = undefined;
              audit("GAME_PREPARING");
              if (engine(l.game).startCountdownSeconds === 0)
                audit(prepareRound(l, service.context()));
              break;
            case "INVENTORY": {
              service.limit(uuid, "inventory", 300);
              m.inventory = [
                ...new Set(
                  event.items.filter((id: string) => m.catalog.includes(id)),
                ),
              ];
              m.inventoryAt = service.now();
              if (
                l.state === "ACTIVE" &&
                !l.pause &&
                m.status === "ACTIVE" &&
                m.connection === "CONNECTED" &&
                ["bingo", "item_hunt", "collector"].includes(l.game)
              )
                engine(l.game).handle(l, m, event, service.context());
              break;
            }
            case "POSITION": {
              service.limit(uuid, "position", 180);
              m.position = {
                x: event.x,
                y: event.y,
                z: event.z,
                dimension: event.dimension,
                elytra: event.elytra,
                at: service.now(),
              };
              if (
                l.state === "ACTIVE" &&
                !l.pause &&
                m.status === "ACTIVE" &&
                l.game === "hide_seek"
              )
                engine(l.game).handle(l, m, event, service.context());
              break;
            }
            case "REMATCH":
              ensure(
                l.state === "RESULTS" || l.state === "REMATCH",
                "NOT_RESULTS",
              );
              l.state = "REMATCH";
              l.data.rematch ??= {};
              if (!event.accept) {
                l.state = "FINISHED";
                audit("REMATCH_DECLINED");
                break;
              }
              l.data.rematch[uuid] = true;
              if (l.members.every((m) => l!.data.rematch[m.uuid])) {
                l.round++;
                l.retired = [];
                l.state = "PREPARING";
                l.preparingAt = service.now();
                for (const m of l.members) {
                  m.status = "ACTIVE";
                  m.score = 0;
                  m.metrics = {};
                  m.inventoryAt = undefined;
                }
                l.winners = [];
                audit("REMATCH_ACCEPTED");
                if (engine(l.game).startCountdownSeconds === 0) {
                  ensure(
                    l.members.every((m) => m.connection === "CONNECTED"),
                    "PLAYERS_NOT_CONNECTED",
                  );
                  audit(prepareRound(l, service.context()));
                }
              }
              break;
            default:
              ensure(l.state === "ACTIVE" && !l.pause, "GAME_NOT_ACTIVE");
              ensure(
                m.status === "ACTIVE" && m.connection === "CONNECTED",
                "PLAYER_NOT_ACTIVE",
              );
              if (event.type === "GUESS")
                service.limit(uuid, "guess", 12, 10000);
              else service.limit(uuid, "game", 100, 10000);
              if (event.type === "HIT") {
                const t = member(l, event.target);
                ensure(
                  t.connection === "CONNECTED" && t.status === "ACTIVE",
                  "TARGET_NOT_ACTIVE",
                );
                const a = m.position,
                  b = t.position;
                ensure(
                  a &&
                    b &&
                    service.now() - a.at < 3000 &&
                    service.now() - b.at < 3000 &&
                    a.dimension === b.dimension &&
                    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= 6,
                  "HIT_NOT_PLAUSIBLE",
                );
              }
              engine(l.game).handle(l, m, event, service.context());
              audit("GAME_EVENT", { eventType: event.type });
          }
        }
      }
      if (l) {
        if (l.state === "RESULTS" && l.data.statsRecorded !== l.round)
          audit("GAME_FINISHED", { winners: l.winners });
        await service.commit(l, events, {
          id: event.requestId,
          player: uuid,
          hash,
        });
      }
      notifications.forEach((fn) => fn());
      client.send({ type: "ACK", requestId: event.requestId });
    } catch (error) {
      service.lobbies = new Map(backup);
      service.invites = new Map(invites);
      throw error;
    }
  });
}
