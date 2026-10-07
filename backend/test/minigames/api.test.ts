import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import WebSocket from "ws";
import { PNG } from "pngjs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { photoRoot } from "../../src/minigames/storage.js";
import { buildApp } from "../../src/app.js";
import { prisma } from "../../src/database/prisma.js";
import { createSession } from "../../src/auth/session.js";
import { config } from "../../src/config/config.js";
import { tokenHash } from "../../src/minigames/auth.js";
import { hello, event } from "./helpers.js";
let app: Awaited<ReturnType<typeof buildApp>>,
  adminCookie: string,
  userCookie: string,
  csrf: string,
  userId: string,
  adminId: string;
beforeAll(async () => {
  const admin = await prisma.user.create({
    data: {
      username: "mg-admin-" + randomUUID().slice(0, 8),
      passwordHash: "test",
      role: "ADMIN",
    },
  });
  const user = await prisma.user.create({
    data: {
      username: "mg-user-" + randomUUID().slice(0, 8),
      passwordHash: "test",
      role: "USER",
    },
  });
  adminId = admin.id;
  userId = user.id;
  const a = await createSession(admin.id, {}),
    u = await createSession(user.id, {});
  adminCookie = config.session.cookieName + "=" + a.sessionId;
  userCookie = config.session.cookieName + "=" + u.sessionId;
  csrf = a.csrfToken;
  app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
});
afterAll(async () => {
  await app.close();
  await prisma.user.deleteMany({ where: { id: { in: [adminId, userId] } } });
  vi.unstubAllGlobals();
});
it("protects every admin route server-side", async () => {
  const id = randomUUID();
  for (const path of [
    "dashboard",
    "lobbies",
    "lobbies/" + id,
    "players",
    "content",
    "games",
    "logs",
  ]) {
    expect(
      (await app.inject({ url: "/api/minigames/admin/" + path })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/minigames/admin/" + path,
          headers: { cookie: userCookie },
        })
      ).statusCode,
    ).toBe(403);
  }
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: "/api/minigames/admin/lobbies/" + id,
        headers: { cookie: userCookie },
      })
    ).statusCode,
  ).toBe(403);
});
it("requires CSRF for content edits; validates item fairness and pagination", async () => {
  const body = {
    kind: "word",
    enabled: true,
    data: { word: "Pinguin", difficulty: "MITTEL" },
  };
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/minigames/admin/content/api-word",
        headers: { cookie: adminCookie },
        payload: body,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/minigames/admin/content/api-word",
        headers: { cookie: adminCookie, "x-csrf-token": csrf },
        payload: body,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        url: "/api/minigames/admin/logs?limit=99999",
        headers: { cookie: adminCookie },
      })
    ).statusCode,
  ).toBe(400);
  const bad = {
    kind: "item",
    enabled: true,
    data: {
      itemId: "minecraft:dragon_egg",
      displayNameDe: "Drachenei",
      survivalObtainable: true,
      difficulty: "SCHWER",
      bingoEligible: true,
      itemHuntEligible: true,
      collectorEligible: true,
      supportedVersions: ["1.21.11"],
    },
  };
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/minigames/admin/content/minecraft:dragon_egg",
        headers: { cookie: adminCookie, "x-csrf-token": csrf },
        payload: bad,
      })
    ).statusCode,
  ).toBe(400);
});
it("Minecraft proof is required; challenge is one-use and tokens are hashed", async () => {
  const uuid = randomUUID();
  const challenge = await app.inject({
    method: "POST",
    url: "/api/minigames/auth/challenge",
    payload: { name: "Desmodus" },
  });
  expect(challenge.statusCode).toBe(200);
  const body = challenge.json();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: uuid.replaceAll("-", ""), name: "Desmodus" }),
    }),
  );
  const result = await app.inject({
    method: "POST",
    url: "/api/minigames/auth/session",
    payload: { id: body.id, uuid },
  });
  expect(result.statusCode).toBe(200);
  const token = result.json().token;
  expect(token).toHaveLength(43);
  expect(
    await prisma.minigameSession.findUnique({
      where: { tokenHash: tokenHash(token) },
    }),
  ).toBeTruthy();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/minigames/auth/session",
        payload: { id: body.id, uuid },
      })
    ).statusCode,
  ).toBe(400);
  vi.unstubAllGlobals();
});
it("rejects forged UUID despite valid username and rejects invalid screenshot dimensions", async () => {
  const uuid = randomUUID();
  const challenge = (
    await app.inject({
      method: "POST",
      url: "/api/minigames/auth/challenge",
      payload: { name: "Steve" },
    })
  ).json();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: randomUUID().replaceAll("-", ""),
        name: "Steve",
      }),
    }),
  );
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/minigames/auth/session",
        payload: { id: challenge.id, uuid },
      })
    ).statusCode,
  ).toBe(400);
  vi.unstubAllGlobals();
  const token = "a".repeat(43);
  await prisma.minigameSession.upsert({
    where: { tokenHash: tokenHash(token) },
    create: {
      tokenHash: tokenHash(token),
      playerUuid: uuid,
      expiresAt: new Date(Date.now() + 60000),
    },
    update: { playerUuid: uuid, expiresAt: new Date(Date.now() + 60000) },
  });
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(1000000, 16);
  png.writeUInt32BE(1000000, 20);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/minigames/photos",
        headers: { authorization: "Bearer " + token },
        payload: {
          captureId: randomUUID(),
          capturedAt: Date.now(),
          mime: "image/png",
          image: png.toString("base64"),
        },
      })
    ).json().error,
  ).toBe("INVALID_DIMENSIONS");
});
it("WebSocket authenticates, sends snapshots, validates sequence and starts a cross-version lobby", async () => {
  const port = (app.server.address() as { port: number }).port;
  const uuids = [randomUUID(), randomUUID()];
  const sockets: WebSocket[] = [],
    inboxes: any[][] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const token = (i ? "b" : "c").repeat(43);
      await prisma.minigameSession.upsert({
        where: { tokenHash: tokenHash(token) },
        create: {
          tokenHash: tokenHash(token),
          playerUuid: uuids[i],
          expiresAt: new Date(Date.now() + 60000),
        },
        update: {
          playerUuid: uuids[i],
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/minigames`, {
        headers: { authorization: "Bearer " + token },
      });
      sockets.push(ws);
      const inbox: any[] = [];
      inboxes.push(inbox);
      ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      ws.send(
        JSON.stringify({
          ...hello(uuids[i]),
          minecraftVersion: i ? "26.3" : "1.21.11",
        }),
      );
      await waitFor(() => inbox.some((m) => m.type === "WELCOME"));
    }
    sockets[0].send(
      JSON.stringify(event("CREATE", { game: "tictactoe", config: {} })),
    );
    await waitFor(() => inboxes[0].some((m) => m.lobby));
    const l = inboxes[0].find((m) => m.lobby).lobby;
    sockets[1].send(JSON.stringify(event("JOIN", { code: l.code })));
    await waitFor(() => inboxes[1].some((m) => m.lobby));
    expect(
      inboxes[1]
        .find((m) => m.lobby)
        .lobby.members.map((m: any) => m.minecraftVersion),
    ).toEqual(["1.21.11", "26.3"]);
    sockets[0].send(JSON.stringify({ ...event("START"), sequence: 2 }));
    await waitFor(() => inboxes[0].some((m) => m.lobby?.state === "ACTIVE"));
    const active = inboxes[0].filter((m) => m.lobby).at(-1).lobby;
    expect(active.countdownEndsAt).toBeUndefined();
    expect(inboxes.flat().some((m) => m.lobby?.state === "COUNTDOWN")).toBe(
      false,
    );
    const starter = uuids.indexOf(active.data.turn);
    const sequence = starter === 0 ? 3 : 2;
    sockets[starter].send(
      JSON.stringify({ ...event("MOVE", { slot: 0 }), sequence }),
    );
    await waitFor(() =>
      inboxes[starter].some((m) => m.lobby?.data.board?.[0] === uuids[starter]),
    );
    sockets[starter].send(
      JSON.stringify({ ...event("MOVE", { slot: 1 }), sequence: sequence + 1 }),
    );
    await waitFor(() =>
      inboxes[starter].some(
        (m) => m.type === "ERROR" && m.code === "NOT_YOUR_TURN",
      ),
    );
    sockets[0].send(
      JSON.stringify({ ...event("READY", { ready: true }), sequence: 99 }),
    );
    await waitFor(() =>
      inboxes[0].some(
        (m) => m.type === "ERROR" && m.code === "SEQUENCE_MISMATCH",
      ),
    );
  } finally {
    await closeSockets(sockets, uuids);
  }
});
async function waitFor(predicate: () => boolean, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end)
      throw new Error("Timed out waiting for WebSocket packet");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function closeSockets(sockets: WebSocket[], uuids: string[]) {
  await Promise.all(
    sockets.map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) return resolve();
          socket.once("close", () => resolve());
          socket.close();
        }),
    ),
  );
  // Socket closure schedules a serialized database write. Wait for it before
  // the shared Prisma client is disconnected by the test environment.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const players = await prisma.minigamePlayer.findMany({
      where: { uuid: { in: uuids } },
      select: { connectionState: true },
    });
    if (players.every((player) => player.connectionState === "DISCONNECTED"))
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for persisted WebSocket disconnects");
}

it("uploads the exact submission, restricts review access, resolves votes and deletes lobby photos", async () => {
  const port = (app.server.address() as { port: number }).port;
  const uuids = [randomUUID(), randomUUID()],
    tokens = ["g".repeat(43), "h".repeat(43)];
  const sockets: WebSocket[] = [],
    inboxes: any[][] = [],
    sequences = [0, 0];
  const send = (i: number, type: string, p: Record<string, unknown> = {}) =>
    sockets[i].send(
      JSON.stringify({ ...event(type, p), sequence: ++sequences[i] }),
    );
  try {
    for (let i = 0; i < 2; i++) {
      await prisma.minigameSession.upsert({
        where: { tokenHash: tokenHash(tokens[i]) },
        create: {
          tokenHash: tokenHash(tokens[i]),
          playerUuid: uuids[i],
          expiresAt: new Date(Date.now() + 60000),
        },
        update: {
          playerUuid: uuids[i],
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/minigames`, {
        headers: { authorization: "Bearer " + tokens[i] },
      });
      sockets.push(socket);
      const inbox: any[] = [];
      inboxes.push(inbox);
      socket.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send(JSON.stringify(hello(uuids[i])));
      await waitFor(() => inbox.some((m) => m.type === "WELCOME"));
    }
    send(0, "CREATE", { game: "photo_hunt", config: {} });
    await waitFor(() => inboxes[0].some((m) => m.lobby));
    const lobby = inboxes[0].find((m) => m.lobby).lobby;
    send(1, "JOIN", { code: lobby.code });
    await waitFor(() => inboxes[1].some((m) => m.lobby));
    send(0, "START");
    await waitFor(() => inboxes[0].some((m) => m.lobby?.state === "PREPARING"));
    for (let i = 0; i < 2; i++) send(i, "INVENTORY", { items: [] });
    await waitFor(
      () => inboxes[0].some((m) => m.lobby?.state === "ACTIVE"),
      7000,
    );
    const image = new PNG({ width: 16, height: 16 });
    image.data.fill(255);
    const png = PNG.sync.write(image);
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/minigames/photos",
      headers: { authorization: "Bearer " + tokens[0] },
      payload: {
        captureId: randomUUID(),
        capturedAt: Date.now(),
        mime: "image/png",
        image: png.toString("base64"),
      },
    });
    expect(uploaded.statusCode).toBe(200);
    const submission = uploaded.json();
    await waitFor(() =>
      inboxes[1].some((m) => m.lobby?.data.submission?.id === submission.id),
    );
    const download = await app.inject({
      url: "/api/minigames/photos/" + submission.id,
      headers: { authorization: "Bearer " + tokens[1] },
    });
    expect(download.statusCode).toBe(200);
    expect(PNG.sync.read(download.rawPayload).data).toEqual(image.data);
    const outside = randomBytes(32).toString("base64url");
    await prisma.minigameSession.create({
      data: {
        tokenHash: tokenHash(outside),
        playerUuid: randomUUID(),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    expect(
      (
        await app.inject({
          url: "/api/minigames/photos/" + submission.id,
          headers: { authorization: "Bearer " + outside },
        })
      ).statusCode,
    ).toBe(400);
    send(0, "VOTE", { accept: true });
    await waitFor(() => inboxes[0].some((m) => m.code === "CANNOT_VOTE"));
    send(1, "VOTE", { accept: true });
    await waitFor(() => inboxes[0].some((m) => m.lobby?.state === "RESULTS"));
    expect(
      inboxes[0].find((m) => m.lobby?.state === "RESULTS").lobby.winners,
    ).toEqual([uuids[0]]);
    const disbandRequestId = randomUUID();
    send(0, "DISBAND", { requestId: disbandRequestId });
    await waitFor(() => inboxes[0].some((m) => m.type === "LOBBY_CLOSED"));
    await waitFor(() =>
      inboxes[0].some(
        (m) => m.type === "ACK" && m.requestId === disbandRequestId,
      ),
    );
    await expect(readdir(path.join(photoRoot, lobby.id))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  } finally {
    await closeSockets(sockets, uuids);
  }
});
