import { logger } from "../logging/logger.js";
import { ensure, finish, GameError, member } from "./protocol.js";
import { engine } from "./games/index.js";
import { activateRound, prepareRound } from "./rounds.js";
import type { Audit } from "./repository.js";
import type { MinigameService } from "./service.js";

export async function tickService(service: MinigameService) {
  return service.serialize(async () => {
    const now = service.now();
    for (const [uuid, c] of service.clients)
      if (now - c.lastSeen > 45000) {
        c.send({ type: "HEARTBEAT_TIMEOUT" });
        service.clients.delete(uuid);
        const l = service.find(uuid);
        if (l) {
          const m = member(l, uuid);
          m.connection = "TRANSFERRING";
          m.transferringUntil = now + 10000;
        }
      }
    for (const l of [...service.lobbies.values()]) {
      const before = JSON.stringify(l),
        backup = structuredClone(l);
      const events: Audit[] = [];
      const audit = (type: string, playerUuid?: string) =>
        events.push({ type, playerUuid });
      try {
        for (const m of l.members) {
          if (
            m.connection === "TRANSFERRING" &&
            now >= (m.transferringUntil ?? Infinity)
          ) {
            m.connection = "DISCONNECTED";
            m.disconnectedAt = now;
            if (m.status === "ACTIVE" || m.status === "TRANSFERRING")
              m.status = "DISCONNECTED";
            audit("PLAYER_DISCONNECTED", m.uuid);
            if (
              engine(l.game).maxPlayers === 2 &&
              l.state === "ACTIVE" &&
              !l.pause
            )
              l.pause = { since: now, until: now + 60000, player: m.uuid };
          }
          if (
            m.connection === "DISCONNECTED" &&
            m.disconnectedAt &&
            now - m.disconnectedAt >= 60000 &&
            m.status === "DISCONNECTED" &&
            ["ACTIVE", "ROUND_END"].includes(l.state) &&
            engine(l.game).maxPlayers !== 2
          ) {
            engine(l.game).disconnect(l, m, service.context());
            audit("DISCONNECT_EXPIRED", m.uuid);
          }
        }
        if (l.state === "LOBBY")
          for (const m of [...l.members])
            if (
              m.uuid !== l.host &&
              m.connection === "DISCONNECTED" &&
              m.disconnectedAt !== undefined &&
              now - m.disconnectedAt >= 300000
            ) {
              service.remove(l, m);
              audit("PLAYER_LEFT", m.uuid);
            }
        const host = member(l, l.host);
        if (
          l.state === "LOBBY" &&
          ((host.screenClosedAt !== undefined &&
            now - host.screenClosedAt >= 300000) ||
            (host.disconnectedAt !== undefined &&
              now - host.disconnectedAt >= 300000))
        ) {
          l.state = "FINISHED";
          audit("LOBBY_TIMEOUT");
        } else if (
          l.state !== "LOBBY" &&
          host.connection === "DISCONNECTED" &&
          host.disconnectedAt !== undefined &&
          now - host.disconnectedAt >= 300000
        ) {
          const successor =
            l.members.find(
              (m) => m.connection === "CONNECTED" && m.status === "ACTIVE",
            ) ?? l.members.find((m) => m.connection === "CONNECTED");
          if (successor) {
            l.host = successor.uuid;
            audit("HOST_MIGRATED", successor.uuid);
          } else {
            l.state = "FINISHED";
            audit("LOBBY_ABANDONED");
          }
        }
        if (l.pause && now >= l.pause.until) {
          const winners = l.members
            .filter((m) => m.connection === "CONNECTED")
            .map((m) => m.uuid);
          finish(l, winners);
          audit("GAME_FORFEIT");
        }
        if (l.state === "PREPARING") {
          if (
            l.members.every(
              (m) =>
                m.inventoryAt !== undefined &&
                m.inventoryAt >= (l.preparingAt ?? 0) &&
                m.connection === "CONNECTED",
            )
          ) {
            audit(prepareRound(l, service.context()));
          } else if (now - (l.preparingAt ?? now) > 15000) {
            l.state = "LOBBY";
            audit("PREPARATION_TIMEOUT");
          }
        } else if (
          l.state === "COUNTDOWN" &&
          !l.data.resumeAt &&
          now >= (l.countdownEndsAt ?? Infinity) &&
          !l.members.some((m) => m.connection === "TRANSFERRING")
        ) {
          ensure(
            l.members.every((m) => m.connection === "CONNECTED"),
            "PLAYERS_NOT_CONNECTED",
          );
          activateRound(l, service.context());
          audit("GAME_STARTED");
        } else if (
          (["ACTIVE", "ROUND_END"].includes(l.state) ||
            (l.state === "COUNTDOWN" && !!l.data.resumeAt)) &&
          !l.pause
        )
          engine(l.game).tick(l, service.context());
        if (l.state === "RESULTS" && l.data.statsRecorded !== l.round)
          audit("GAME_FINISHED");
        if (JSON.stringify(l) !== before) await service.commit(l, events);
        if (
          l.game === "hot_potato" &&
          l.state === "ACTIVE" &&
          l.data.holder &&
          now >= (l.data.nextPulseAt ?? 0)
        ) {
          service.clients.get(l.data.holder)?.send({ type: "POTATO_PULSE" });
          l.data.nextPulseAt =
            now +
            (l.data.explodesAt - now < 5000
              ? 200
              : l.data.explodesAt - now < 12000
                ? 500
                : 1000);
        }
      } catch (err) {
        service.lobbies.set(l.id, backup);
        if (
          err instanceof GameError &&
          ["PREPARING", "COUNTDOWN"].includes(backup.state) &&
          !backup.data.resumeAt
        ) {
          backup.state = "LOBBY";
          backup.data = {};
          await service.commit(backup, [
            { type: "PREPARATION_FAILED", details: { code: err.code } },
          ]);
        } else logger.error({ err, lobbyId: l.id }, "Minigame tick failed");
      }
    }
    for (const [id, i] of service.invites)
      if (now - i.createdAt > 120000) service.invites.delete(id);
    for (const [key, times] of service.limits)
      if (times.at(-1)! < now - 60000) service.limits.delete(key);
    for (const [key, time] of service.inviteTimes)
      if (time < now - 60000) service.inviteTimes.delete(key);
  });
}
