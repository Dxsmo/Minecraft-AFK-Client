import { prisma } from "../database/prisma.js";
import type { Lobby } from "./protocol.js";
export interface Audit {
  type: string;
  playerUuid?: string;
  details?: Record<string, unknown>;
}
function storedSnapshot(l: Lobby) {
  return JSON.stringify({
    ...l,
    members: l.members.map(({ catalog, ...m }) => m),
    retired: l.retired?.map(({ catalog, ...m }) => m),
  });
}
export class MinigameRepository {
  async load() {
    const players = await prisma.minigamePlayer.findMany({
      select: { uuid: true, itemIds: true },
    });
    const catalogs = new Map(
      players.map((p) => [p.uuid, JSON.parse(p.itemIds) as string[]]),
    );
    return (
      await prisma.minigameLobby.findMany({ where: { finishedAt: null } })
    ).map((row) => {
      const l = JSON.parse(row.snapshot) as Lobby;
      for (const m of l.members) m.catalog = catalogs.get(m.uuid) ?? [];
      return l;
    });
  }

  async persist(
    l: Lobby,
    events: Audit[],
    receipt?: { id: string; player: string; hash: string },
  ) {
    await prisma.$transaction(async (db) => {
      await db.minigameLobby.upsert({
        where: { id: l.id },
        create: {
          id: l.id,
          code: l.code,
          hostUuid: l.host,
          game: l.game,
          network: l.network,
          state: l.state,
          snapshot: storedSnapshot(l),
          revision: l.revision,
          createdAt: new Date(l.createdAt),
          startedAt: l.startedAt ? new Date(l.startedAt) : null,
          finishedAt: l.state === "FINISHED" ? new Date() : null,
        },
        update: {
          hostUuid: l.host,
          state: l.state,
          snapshot: storedSnapshot(l),
          revision: l.revision,
          startedAt: l.startedAt ? new Date(l.startedAt) : null,
          finishedAt: l.state === "FINISHED" ? new Date() : null,
        },
      });
      const storedMembers = new Map(
        (await db.minigameMember.findMany({ where: { lobbyId: l.id } })).map(
          (m) => [m.playerUuid, m],
        ),
      );
      await db.minigameMember.deleteMany({
        where: {
          lobbyId: l.id,
          playerUuid: { notIn: l.members.map((m) => m.uuid) },
        },
      });
      for (const m of l.members) {
        const snapshot = JSON.stringify({ ...m, catalog: undefined }),
          activePlayer = l.state === "FINISHED" ? null : m.uuid;
        const previous = storedMembers.get(m.uuid);
        if (
          previous?.snapshot === snapshot &&
          previous.activePlayer === activePlayer
        )
          continue;
        await db.minigameMember.upsert({
          where: { lobbyId_playerUuid: { lobbyId: l.id, playerUuid: m.uuid } },
          create: { lobbyId: l.id, playerUuid: m.uuid, activePlayer, snapshot },
          update: { activePlayer, snapshot },
        });
      }
      for (const e of events)
        await db.minigameEvent.create({
          data: {
            lobbyId: l.id,
            game: l.game,
            type: e.type,
            playerUuid: e.playerUuid,
            details: JSON.stringify(e.details ?? {}),
          },
        });
      if (receipt)
        await db.minigameReceipt.create({
          data: {
            id: receipt.id,
            playerUuid: receipt.player,
            hash: receipt.hash,
            expiresAt: new Date(Date.now() + 86400000),
          },
        });
      if (l.state === "RESULTS" && l.data.statsRecorded !== l.round) {
        for (const m of [...l.members, ...(l.retired ?? [])]) {
          const previous = await db.minigameStats.findUnique({
            where: { playerUuid_game: { playerUuid: m.uuid, game: l.game } },
          });
          const metrics: Record<string, number> = previous
            ? JSON.parse(previous.metrics)
            : {};
          for (const [key, value] of Object.entries(m.metrics))
            metrics[key] =
              key === "highestUniqueItems"
                ? Math.max(metrics[key] ?? 0, value)
                : (metrics[key] ?? 0) + value;
          const draw =
              l.data.outcome === "DRAW" &&
              (l.winners.length === 0 || l.winners.includes(m.uuid)),
            win = l.data.outcome !== "DRAW" && l.winners.includes(m.uuid);
          const update = {
            gamesPlayed: { increment: 1 },
            wins: { increment: win ? 1 : 0 },
            losses: { increment: !draw && !win ? 1 : 0 },
            draws: { increment: draw ? 1 : 0 },
            metrics: JSON.stringify(metrics),
          };
          await db.minigameStats.upsert({
            where: { playerUuid_game: { playerUuid: m.uuid, game: l.game } },
            create: {
              playerUuid: m.uuid,
              game: l.game,
              gamesPlayed: 1,
              wins: win ? 1 : 0,
              losses: !draw && !win ? 1 : 0,
              draws: draw ? 1 : 0,
              metrics: JSON.stringify(metrics),
            },
            update,
          });
        }
        l.data.statsRecorded = l.round;
        await db.minigameLobby.update({
          where: { id: l.id },
          data: { snapshot: storedSnapshot(l) },
        });
      }
    });
  }
  async receipt(id: string) {
    return prisma.minigameReceipt.findUnique({ where: { id } });
  }
  async content() {
    return (await prisma.minigameContent.findMany()).map((x) => ({
      ...x,
      data: JSON.parse(x.data),
    }));
  }
}
