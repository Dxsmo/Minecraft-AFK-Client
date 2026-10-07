import { beforeAll, beforeEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/database/prisma.js";
import { MinigameService } from "../../src/minigames/service.js";
import { seedContent } from "../../src/minigames/content.js";
import { finish, gameIds } from "../../src/minigames/protocol.js";
import { engine } from "../../src/minigames/games/index.js";
import { hello, event, ids } from "./helpers.js";
let service: MinigameService, now: number, messages: Map<string, any[]>;
beforeAll(async () => {
  await seedContent();
});
beforeEach(async () => {
  await prisma.minigameMember.deleteMany();
  await prisma.minigameEvent.deleteMany();
  await prisma.minigameLobby.deleteMany();
  await prisma.minigameReceipt.deleteMany();
  now = Date.now();
  messages = new Map();
  service = new MinigameService(undefined, () => now);
  await service.init();
  const catalog = service.content
    .filter((x) => x.kind === "item")
    .map((x) => x.id);
  for (const id of ids) {
    messages.set(id, []);
    await service.connect(
      hello(id, catalog),
      (m) => messages.get(id)!.push(m),
      id,
    );
  }
});
const send = (id: string, type: string, p: Record<string, unknown> = {}) =>
  service.handle(id, event(type, p, now));
async function create(game = "bingo", config: Record<string, unknown> = {}) {
  await send(ids[0], "CREATE", { game, config });
  return service.find(ids[0])!;
}
async function joined(game = "bingo") {
  const l = await create(game);
  await send(ids[1], "JOIN", { code: l.code });
  return l;
}
async function started(game = "bingo") {
  const l = await joined(game);
  await send(ids[0], "START");
  for (const m of l.members) await send(m.uuid, "INVENTORY", { items: [] });
  await service.tick();
  now += 5001;
  await service.tick();
  return service.find(ids[0])!;
}
describe("authoritative lobbies", () => {
  it("joins exact code and rejects changed case", async () => {
    const l = await create();
    const bad = l.code.replace(/[a-zA-Z]/, (c) =>
      c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
    );
    await expect(send(ids[1], "JOIN", { code: bad })).rejects.toThrow(
      "LOBBY_NOT_FOUND",
    );
    await send(ids[1], "JOIN", { code: l.code });
    expect(service.find(ids[1])?.id).toBe(l.id);
  });
  it("enforces max players and one-player-one-lobby", async () => {
    const l = await create("bingo", { maxPlayers: 2 });
    await send(ids[1], "JOIN", { code: l.code });
    await expect(send(ids[2], "JOIN", { code: l.code })).rejects.toThrow(
      "LOBBY_FULL",
    );
    await expect(
      send(ids[0], "CREATE", { game: "bingo", config: {} }),
    ).rejects.toThrow("ALREADY_IN_LOBBY");
    await expect(send(ids[1], "JOIN", { code: l.code })).rejects.toThrow(
      "ALREADY_IN_LOBBY",
    );
  });
  it("first kick allows rejoin; second kick bans only this lobby", async () => {
    let l = await joined();
    await send(ids[0], "KICK", { target: ids[1], ban: false });
    await send(ids[1], "JOIN", { code: l.code });
    await send(ids[0], "KICK", { target: ids[1], ban: false });
    await expect(send(ids[1], "JOIN", { code: l.code })).rejects.toThrow(
      "LOBBY_BANNED",
    );
    await send(ids[0], "DISBAND");
    l = await create();
    await send(ids[1], "JOIN", { code: l.code });
    expect(service.find(ids[1])?.id).toBe(l.id);
  });
  it("right click bans immediately and only host may kick", async () => {
    const l = await joined();
    await expect(
      send(ids[1], "KICK", { target: ids[0], ban: true }),
    ).rejects.toThrow("HOST_REQUIRED");
    await send(ids[0], "KICK", { target: ids[1], ban: true });
    await expect(send(ids[1], "JOIN", { code: l.code })).rejects.toThrow(
      "LOBBY_BANNED",
    );
  });
  it("ready is optional for host start and countdown is five seconds", async () => {
    const l = await joined();
    await send(ids[1], "READY", { ready: true });
    expect(l.members[1].ready).toBe(true);
    await send(ids[0], "START");
    for (const m of l.members) await send(m.uuid, "INVENTORY", { items: [] });
    await service.tick();
    expect(l.state).toBe("COUNTDOWN");
    now += 4999;
    await service.tick();
    expect(l.state).toBe("COUNTDOWN");
    now += 2;
    await service.tick();
    expect(l.state).toBe("ACTIVE");
  });
  it("screen reopening resets host timeout", async () => {
    await create();
    await send(ids[0], "SCREEN", { open: false });
    now += 299999;
    for (const c of service.clients.values()) c.lastSeen = now;
    await service.tick();
    expect(service.find(ids[0])).toBeTruthy();
    await send(ids[0], "SCREEN", { open: true });
    now += 2;
    for (const c of service.clients.values()) c.lastSeen = now;
    await service.tick();
    expect(service.find(ids[0])).toBeTruthy();
    await send(ids[0], "SCREEN", { open: false });
    now += 300001;
    for (const c of service.clients.values()) c.lastSeen = now;
    await service.tick();
    expect(service.find(ids[0])).toBeUndefined();
  });
  it("server enforces invite cooldown and candidate eligibility", async () => {
    await create();
    await send(ids[0], "INVITE", { target: ids[1] });
    await expect(send(ids[0], "INVITE", { target: ids[1] })).rejects.toThrow(
      "INVITE_COOLDOWN",
    );
    now += 60001;
    await send(ids[0], "INVITE", { target: ids[1] });
    const invites = messages.get(ids[1])!.filter((m) => m.type === "INVITE");
    expect(invites).toHaveLength(2);
    await send(ids[1], "INVITE_REPLY", {
      inviteId: invites[1].inviteId,
      accept: true,
    });
    expect(service.find(ids[1])).toBeTruthy();
  });
  it("reconnect restores full state and shard handoff preserves ready/score", async () => {
    const l = await joined();
    await send(ids[1], "READY", { ready: true });
    l.members[1].score = 12;
    await send(ids[1], "CONNECTION", { state: "TRANSFERRING" });
    now += 5000;
    await service.tick();
    expect(l.members[1].disconnectedAt).toBeUndefined();
    await send(ids[1], "CONNECTION", { state: "CONNECTED" });
    expect(l.members[1].score).toBe(12);
    expect(l.members[1].ready).toBe(true);
    await service.disconnect(ids[1], ids[1]);
    await service.connect(
      hello(ids[1], l.members[1].catalog),
      (m) => messages.get(ids[1])!.push(m),
      randomUUID(),
    );
    expect(messages.get(ids[1])!.at(-1).lobby.members[1].score).toBe(12);
  });
  it("persists snapshots and restores membership across backend restart", async () => {
    const l = await joined();
    await send(ids[1], "READY", { ready: true });
    const restored = new MinigameService(undefined, () => now);
    await restored.init();
    expect(restored.find(ids[1])?.id).toBe(l.id);
    expect(restored.find(ids[1])?.members[1].ready).toBe(true);
  });
  it("pauses two-player games and forfeits after disconnect grace", async () => {
    await started("tictactoe");
    await service.disconnect(ids[1], ids[1]);
    now += 10001;
    await service.tick();
    expect(service.find(ids[0])?.pause).toBeTruthy();
    now += 60001;
    service.clients.get(ids[0])!.lastSeen = now;
    await service.tick();
    expect(service.find(ids[0])?.winners).toEqual([ids[0]]);
  });
  it("migrates host during running game and preserves config", async () => {
    const l = await started();
    const config = structuredClone(l.config);
    await service.disconnect(ids[0], ids[0]);
    now += 10001;
    await service.tick();
    now += 300001;
    for (const id of ids.slice(1)) service.clients.get(id)!.lastSeen = now;
    await service.tick();
    expect(service.find(ids[1])?.host).toBe(ids[1]);
    expect(service.find(ids[1])?.config).toEqual(config);
  });
  it("keeps immutable lobby configuration despite website defaults changes", async () => {
    const l = await create("bingo", { boardSize: 5 });
    await prisma.minigameContent.upsert({
      where: { id: "bingo" },
      create: {
        id: "bingo",
        kind: "settings",
        data: JSON.stringify({ boardSize: 3 }),
      },
      update: { data: JSON.stringify({ boardSize: 3 }) },
    });
    service.content = await service.repository.content();
    expect(l.config.boardSize).toBe(5);
    await send(ids[0], "DISBAND");
    const next = await create();
    expect(next.config.boardSize).toBe(3);
    await prisma.minigameContent.delete({ where: { id: "bingo" } });
  });
  it("idempotent command does not repeat kicks; reuse by another player is rejected", async () => {
    await joined();
    const kick = event("KICK", { target: ids[1], ban: false }, now);
    await service.handle(ids[0], kick);
    await service.handle(ids[0], kick);
    expect(service.find(ids[0])?.kicks[ids[1]]).toBe(1);
    await expect(service.handle(ids[1], kick)).rejects.toThrow(
      "IDEMPOTENCY_CONFLICT",
    );
  });
});

describe("instant window game starts", () => {
  const games = ["tictactoe", "connect_four", "memory", "rps"];
  it.each(games)(
    "starts %s and accepts input in the START response without inventory reports",
    async (game) => {
      const l = await joined(game);
      await send(ids[0], "START");
      expect(l.state).toBe("ACTIVE");
      expect(l.startedAt).toBe(now);
      expect(l.countdownEndsAt).toBeUndefined();
      expect(l.members.every((m) => m.inventoryAt === undefined)).toBe(true);
      expect(
        messages
          .get(ids[0])!
          .filter((m) => m.type === "SNAPSHOT")
          .at(-1).lobby.state,
      ).toBe("ACTIVE");
      if (game === "rps") {
        await send(ids[0], "CHOICE", { choice: "rock" });
        expect(l.data.choices[ids[0]]).toBe("rock");
        await send(ids[1], "CHOICE", { choice: "scissors" });
        expect(l.data.revealEndsAt).toBe(now + 3000);
        expect(service.publicSnapshot(l, ids[1]).data.choices[ids[0]]).toBe(
          "chosen",
        );
      } else {
        const player = l.data.turn;
        await send(player, "MOVE", { slot: 0 });
        if (game === "memory") expect(l.data.revealed).toEqual([0]);
        else expect(l.data.board.filter(Boolean)).toEqual([player]);
      }
      expect(
        await prisma.minigameEvent.count({
          where: { lobbyId: l.id, type: "COUNTDOWN_STARTED" },
        }),
      ).toBe(0);
      expect(
        await prisma.minigameEvent.count({
          where: { lobbyId: l.id, type: "GAME_STARTED" },
        }),
      ).toBe(1);
    },
  );
  it.each(games)(
    "starts %s rematches immediately after both votes",
    async (game) => {
      const l = await joined(game);
      await send(ids[0], "START");
      finish(l, [ids[0]]);
      await service.commit(l, [{ type: "GAME_FINISHED" }]);
      await send(ids[0], "REMATCH", { accept: true });
      expect(l.state).toBe("REMATCH");
      await send(ids[1], "REMATCH", { accept: true });
      expect(l.state).toBe("ACTIVE");
      expect(l.round).toBe(2);
      expect(l.countdownEndsAt).toBeUndefined();
      expect(
        l.members.every((m) => m.score === 0 && m.status === "ACTIVE"),
      ).toBe(true);
      expect(
        await prisma.minigameEvent.count({
          where: { lobbyId: l.id, type: "COUNTDOWN_STARTED" },
        }),
      ).toBe(0);
      expect(
        await prisma.minigameEvent.count({
          where: { lobbyId: l.id, type: "GAME_STARTED" },
        }),
      ).toBe(2);
    },
  );
});

describe("recovery and durable outcomes", () => {
  it("requires unanimous rematch votes and alternates the initial starter", async () => {
    const l = await started("tictactoe");
    const first = l.data.turn;
    finish(l, [first]);
    await service.commit(l, [{ type: "GAME_FINISHED" }]);
    await send(ids[0], "REMATCH", { accept: true });
    expect(l.state).toBe("REMATCH");
    await send(ids[1], "REMATCH", { accept: true });
    expect(l.state).toBe("ACTIVE");
    expect(l.countdownEndsAt).toBeUndefined();
    expect(l.round).toBe(2);
    expect(l.data.turn).not.toBe(first);
    expect(l.matchScores[first]).toBe(1);
  });
  it("declining a rematch releases both lobby memberships", async () => {
    const l = await started("tictactoe");
    finish(l, []);
    await service.commit(l, [{ type: "GAME_FINISHED" }]);
    await send(ids[1], "REMATCH", { accept: false });
    expect(service.find(ids[0])).toBeUndefined();
    expect(service.find(ids[1])).toBeUndefined();
  });
  it("does not pause, eliminate or discard the potato during a short shard handoff", async () => {
    const l = await started("hot_potato");
    const holder = l.data.holder;
    const deadline = l.data.explodesAt;
    l.data.explodesAt = now + 500;
    await send(holder, "CONNECTION", { state: "TRANSFERRING" });
    now += 500;
    await service.tick();
    expect(l.data.holder).toBe(holder);
    expect(l.state).toBe("ACTIVE");
    expect(l.pause).toBeUndefined();
    expect(l.members.find((m) => m.uuid === holder)?.status).toBe(
      "TRANSFERRING",
    );
    await send(holder, "CONNECTION", { state: "CONNECTED" });
    l.data.explodesAt = deadline;
    expect(l.members.find((m) => m.uuid === holder)?.status).toBe("ACTIVE");
  });
  it("records tied collector leaders as draws exactly once", async () => {
    await prisma.minigameStats.deleteMany({
      where: { playerUuid: { in: ids } },
    });
    const l = await started("collector");
    l.members[0].score = 5;
    l.members[1].score = 5;
    finish(l, [ids[0], ids[1]]);
    await service.commit(l, [{ type: "GAME_FINISHED" }]);
    await service.commit(l, []);
    for (const uuid of ids.slice(0, 2)) {
      const stats = await prisma.minigameStats.findUnique({
        where: { playerUuid_game: { playerUuid: uuid, game: "collector" } },
      });
      expect(stats?.gamesPlayed).toBe(1);
      expect(stats?.draws).toBe(1);
      expect(stats?.wins).toBe(0);
    }
    expect(l.matchScores).toEqual({});
  });
  it("restores invite cooldown after a backend restart", async () => {
    const l = await create();
    await send(ids[0], "INVITE", { target: ids[1] });
    const restarted = new MinigameService(undefined, () => now);
    await restarted.init();
    for (const uuid of ids)
      await restarted.connect(
        hello(uuid, l.members[0].catalog),
        () => {},
        uuid,
      );
    await expect(
      restarted.handle(ids[0], event("INVITE", { target: ids[1] }, now)),
    ).rejects.toThrow("INVITE_COOLDOWN");
  });
});

it("keeps countdown state and skips engine ticks while a shard handoff completes", async () => {
  const l = await joined("hot_potato");
  await send(ids[0], "START");
  for (const m of l.members) await send(m.uuid, "INVENTORY", { items: [] });
  await service.tick();
  now += 1000;
  await service.tick();
  expect(l.data.explodesAt).toBeUndefined();
  await send(ids[1], "CONNECTION", { state: "TRANSFERRING" });
  now += 5000;
  await service.tick();
  expect(l.state).toBe("COUNTDOWN");
  expect(l.data.explodesAt).toBeUndefined();
  await send(ids[1], "CONNECTION", { state: "CONNECTED" });
  await service.tick();
  expect(l.state).toBe("ACTIVE");
  expect(Number.isFinite(l.data.explodesAt)).toBe(true);
});

it.each(gameIds)(
  "creates, prepares and starts %s with valid snapshots at every phase",
  async (game) => {
    const l = await joined(game);
    for (const m of l.members)
      await send(m.uuid, "POSITION", {
        x: 0,
        y: 64,
        z: 0,
        dimension: "minecraft:overworld",
        elytra: false,
      });
    await send(ids[0], "START");
    for (const m of l.members) await send(m.uuid, "INVENTORY", { items: [] });
    await service.tick();
    const instant = engine(game).startCountdownSeconds === 0;
    expect(l.state).toBe(instant ? "ACTIVE" : "COUNTDOWN");
    now += 1000;
    await service.tick();
    expect(l.state).toBe(instant ? "ACTIVE" : "COUNTDOWN");
    now += 4001;
    await service.tick();
    expect(l.state).toBe("ACTIVE");
    for (const m of l.members) {
      expect(() => service.publicSnapshot(l, m.uuid)).not.toThrow();
    }
    expect(
      messages
        .get(ids[0])!
        .filter((m) => m.type === "SNAPSHOT")
        .at(-1).lobby.state,
    ).toBe("ACTIVE");
  },
);
