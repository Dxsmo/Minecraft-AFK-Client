import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { z } from "zod";
import { prisma } from "../database/prisma.js";
import { photoRoot } from "./storage.js";
import { logger } from "../logging/logger.js";
import { authenticate, createChallenge, verifyChallenge } from "./auth.js";
import {
  eventSchema,
  handshakeSchema,
  ensure,
  GameError,
  member,
  metric,
  SUPPORTED_VERSIONS,
} from "./protocol.js";
import { engine, engines, validateConfig } from "./games/index.js";
import {
  itemContentSchema,
  wordContentSchema,
  photoContentSchema,
  seedContent,
} from "./content.js";
import { MinigameService } from "./service.js";
const parse = <S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
): z.output<S> => {
  const result = schema.safeParse(input);
  ensure(result.success, "INVALID_PAYLOAD");
  return result.data;
};
const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
export default async function minigameRoutes(app: FastifyInstance) {
  const service = new MinigameService();
  const sockets = new Set<WebSocket>();
  let timer: NodeJS.Timeout | undefined;
  let ticks = 0;
  app.addHook("onReady", async () => {
    await seedContent();
    await service.init();
    // A backend restart invalidates all former photo reviews and deletes orphaned files.
    await rm(photoRoot, {
      recursive: true,
      force: true,
    });
    for (const l of service.lobbies.values())
      if (l.data.submission) {
        delete l.data.submission;
        l.state = "COUNTDOWN";
        l.data.resumeAt = Date.now() + 3000;
        l.countdownEndsAt = l.data.resumeAt;
        await service.repository.persist(l, [
          { type: "SCREENSHOT_REVIEW_INTERRUPTED" },
        ]);
      }
    timer = setInterval(() => {
      void service
        .tick()
        .catch((err) => logger.error({ err }, "Minigame scheduler failed"));
      if (++ticks % 120 === 0) {
        void prisma.minigameSession.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        void prisma.minigameChallenge.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        void prisma.minigameReceipt.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        void prisma.minigamePlayer.updateMany({
          where: { uuid: { in: [...service.clients.keys()] } },
          data: { lastSeen: new Date() },
        });
      }
    }, 500);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    for (const socket of sockets) socket.close(1001, "Service restarting");
    await service.serialize(async () => {});
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof GameError)
      return reply
        .code(err.code === "UNAUTHORIZED" ? 401 : 400)
        .send({ error: err.code });
    req.log.error({ err }, "Minigame request failed");
    return reply
      .code((err as any).statusCode ?? 500)
      .send({ error: "MINIGAME_SERVICE_ERROR" });
  });
  app.post(
    "/api/minigames/auth/challenge",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) =>
      createChallenge(
        parse(
          z.object({ name: z.string().regex(/^[A-Za-z0-9_]{3,16}$/) }).strict(),
          req.body,
        ).name,
      ),
  );
  app.post(
    "/api/minigames/auth/session",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const b = parse(
        z.object({ id: z.string().uuid(), uuid: z.string().uuid() }).strict(),
        req.body,
      );
      return verifyChallenge(b.id, b.uuid);
    },
  );
  app.get("/api/minigames/content", async (req) => {
    await authenticate(req.headers.authorization);
    return {
      catalogVersion: "1",
      supportedVersions: SUPPORTED_VERSIONS,
      content: service.content.filter(
        (x) => x.enabled && x.kind !== "settings",
      ),
      games: [...engines.values()].map((e) => ({
        id: e.id,
        icon: e.icon,
        minPlayers: e.minPlayers,
        maxPlayers: e.maxPlayers,
        usesTimer: e.usesTimer,
        usesGameScreen: e.usesGameScreen,
        startCountdownSeconds: e.startCountdownSeconds,
        defaults: validateConfig(e.id, {}),
      })),
    };
  });
  app.get("/ws/minigames", { websocket: true }, (socket, req) => {
    sockets.add(socket);
    const connectionId = randomUUID();
    let uuid: string | undefined;
    let hello = false;
    let sequence = 0;
    let authExpiry = 0;
    let jobs = Promise.resolve();
    let pending = 0;
    let messages = 0;
    let window = Date.now();
    const send = (data: unknown) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > 2 * 1024 * 1024) {
        socket.close(4429, "Slow consumer");
        return;
      }
      socket.send(JSON.stringify(data));
    };
    const deadline = setTimeout(
      () => socket.close(4401, "Handshake required"),
      10000,
    );
    socket.on("message", (raw) => {
      if (Buffer.byteLength(raw as Buffer) > 256 * 1024 || ++pending > 32) {
        socket.close(4400, "Payload limit");
        return;
      }
      if (Date.now() - window > 10000) {
        window = Date.now();
        messages = 0;
      }
      if (++messages > 150) {
        socket.close(4429, "Rate limit");
        return;
      }
      jobs = jobs
        .then(async () => {
          try {
            ensure(socket.readyState === socket.OPEN, "CONNECTION_CLOSED");
            const packet = JSON.parse(raw.toString());
            if (!hello) {
              const session = await authenticate(req.headers.authorization);
              const h = parse(handshakeSchema, packet);
              ensure(h.playerUuid === session.playerUuid, "IDENTITY_MISMATCH");
              uuid = h.playerUuid;
              authExpiry = session.expiresAt.getTime();
              await service.connect(h, send, connectionId);
              hello = true;
              clearTimeout(deadline);
            } else {
              ensure(authExpiry > Date.now(), "SESSION_EXPIRED");
              const e = parse(eventSchema, packet);
              ensure(e.sequence === sequence + 1, "SEQUENCE_MISMATCH");
              sequence = e.sequence;
              await service.handle(uuid!, e, connectionId);
            }
          } catch (err) {
            send({
              type: "ERROR",
              code: err instanceof GameError ? err.code : "INVALID_MESSAGE",
            });
            if (
              err instanceof GameError &&
              ["UNAUTHORIZED", "IDENTITY_MISMATCH", "SESSION_EXPIRED"].includes(
                err.code,
              )
            )
              socket.close(4401, "Unauthorized");
            logger.debug(
              {
                code: err instanceof GameError ? err.code : "INVALID_MESSAGE",
                playerUuid: uuid,
              },
              "Minigame event rejected",
            );
          } finally {
            pending--;
          }
        })
        .catch((err) => logger.error({ err }, "Minigame socket job failed"));
    });
    socket.on("close", () => {
      clearTimeout(deadline);
      sockets.delete(socket);
      if (uuid)
        void service
          .disconnect(uuid, connectionId)
          .catch((err) =>
            logger.error(
              { err, playerUuid: uuid },
              "Minigame disconnect failed",
            ),
          );
    });
    socket.on("error", () => socket.close());
  });
  app.post(
    "/api/minigames/photos",
    {
      bodyLimit: 3 * 1024 * 1024,
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
    },
    async (req) => {
      const auth = await authenticate(req.headers.authorization);
      const b = parse(
        z
          .object({
            captureId: z.string().uuid(),
            capturedAt: z.number().int(),
            mime: z.literal("image/png"),
            image: z.string().max(2800000),
          })
          .strict(),
        req.body,
      );
      ensure(Math.abs(Date.now() - b.capturedAt) < 15000, "SCREENSHOT_EXPIRED");
      const png = Buffer.from(b.image, "base64");
      ensure(
        png.length >= 24 &&
          png.length <= 2 * 1024 * 1024 &&
          png
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        "INVALID_SCREENSHOT",
      );
      const width = png.readUInt32BE(16),
        height = png.readUInt32BE(20);
      ensure(
        width >= 16 && height >= 16 && width <= 1920 && height <= 1080,
        "INVALID_DIMENSIONS",
      );
      let decoded: PNG;
      try {
        decoded = PNG.sync.read(png, { checkCRC: true });
      } catch {
        throw new GameError("INVALID_SCREENSHOT");
      }
      ensure(
        decoded.width === width && decoded.height === height,
        "INVALID_SCREENSHOT",
      );
      return service.serialize(async () => {
        const l = service.find(auth.playerUuid);
        ensure(
          l &&
            l.game === "photo_hunt" &&
            l.state === "ACTIVE" &&
            !l.pause &&
            !l.data.submission,
          "PHOTO_NOT_ACTIVE",
        );
        const m = member(l, auth.playerUuid);
        ensure(
          m.status === "ACTIVE" &&
            m.connection === "CONNECTED" &&
            service.clients
              .get(m.uuid)
              ?.hello.capabilities.includes("photo_consent"),
          "PHOTO_CONSENT_REQUIRED",
        );
        ensure(
          Date.now() >= (l.data.cooldowns[m.uuid] ?? 0),
          "SUBMISSION_COOLDOWN",
        );
        const eligible = l.members
          .filter(
            (x) =>
              x.uuid !== m.uuid &&
              x.connection === "CONNECTED" &&
              x.status === "ACTIVE",
          )
          .map((x) => x.uuid);
        ensure(eligible.length, "NO_VOTERS");
        const id = randomUUID(),
          directory = path.join(photoRoot, l.id);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(
          path.join(directory, id + ".png"),
          PNG.sync.write(decoded),
          { mode: 0o600 },
        );
        l.data.pausedAt = Date.now();
        l.data.submission = {
          id,
          player: m.uuid,
          eligible,
          votes: {},
          voteEndsAt: Date.now() + 60000,
        };
        metric(m, "submissions");
        await service.commit(l, [
          {
            type: "SCREENSHOT_SUBMITTED",
            playerUuid: m.uuid,
            details: { id, width, height },
          },
        ]);
        return { id };
      });
    },
  );
  app.get("/api/minigames/photos/:id", async (req, reply) => {
    const auth = await authenticate(req.headers.authorization);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const l = service.find(auth.playerUuid);
    ensure(l && l.data.submission?.id === id, "SCREENSHOT_NOT_FOUND");
    return reply
      .header("Content-Type", "image/png")
      .header("Cache-Control", "no-store")
      .send(await readFile(path.join(photoRoot, l.id, id + ".png")));
  });
  const guard = { preHandler: app.requireAdmin };
  const mutate = { preHandler: [app.requireAdmin, app.requireCsrf] };
  app.get("/api/minigames/admin/dashboard", guard, async () => {
    await prisma.$queryRaw`SELECT 1`;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const events = await prisma.minigameEvent.findMany({
      where: { type: { in: ["PREPARATION_FAILED", "PREPARATION_TIMEOUT"] } },
      take: 20,
      orderBy: { createdAt: "desc" },
    });
    const distribution = (key: "minecraftVersion" | "protocolVersion") =>
      Object.fromEntries(
        [...service.clients.values()].reduce((map, c) => {
          const k = String(c.hello[key]);
          map.set(k, (map.get(k) ?? 0) + 1);
          return map;
        }, new Map<string, number>()),
      );
    return {
      serviceStatus: "ok",
      databaseStatus: "ok",
      uptimeSeconds: Math.floor(process.uptime()),
      connectedClients: service.clients.size,
      activeLobbies: service.lobbies.size,
      runningGames: [...service.lobbies.values()].filter((l) =>
        ["COUNTDOWN", "ACTIVE", "ROUND_END"].includes(l.state),
      ).length,
      gamesToday: await prisma.minigameEvent.count({
        where: { type: "GAME_STARTED", createdAt: { gte: start } },
      }),
      websocketConnections: sockets.size,
      versionDistribution: distribution("minecraftVersion"),
      protocolDistribution: distribution("protocolVersion"),
      recentErrors: events,
    };
  });
  app.get("/api/minigames/admin/lobbies", guard, async (req) => {
    const p = parse(pagination, req.query);
    const rows = [...service.lobbies.values()].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
    return {
      total: rows.length,
      items: rows.slice(p.offset, p.offset + p.limit).map((l) => ({
        ...service.publicSnapshot(l, "admin"),
        code: "••••••••",
        streamerModeCount: l.members.filter((m) => m.streamerMode).length,
      })),
    };
  });
  app.get("/api/minigames/admin/lobbies/:id", guard, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const query = parse(
      z.object({ reveal: z.enum(["true", "false"]).default("false") }),
      req.query,
    );
    const l = service.lobbies.get(id);
    ensure(l, "LOBBY_NOT_FOUND");
    return {
      ...service.publicSnapshot(l, "admin"),
      code: query.reveal === "true" ? l.code : "••••••••",
      events: await prisma.minigameEvent.findMany({
        where: { lobbyId: id },
        take: 100,
        orderBy: { createdAt: "desc" },
      }),
    };
  });
  app.delete("/api/minigames/admin/lobbies/:id", mutate, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await service.closeByAdmin(id, req.session!.user.id);
    return { ok: true };
  });
  app.get("/api/minigames/admin/players", guard, async (req) => {
    const p = parse(pagination, req.query);
    const players = await prisma.minigamePlayer.findMany({
      orderBy: { lastSeen: "desc" },
      take: p.limit,
      skip: p.offset,
      select: {
        uuid: true,
        name: true,
        minecraftVersion: true,
        modVersion: true,
        protocolVersion: true,
        connectionState: true,
        lastSeen: true,
        streamerMode: true,
      },
    });
    return {
      total: await prisma.minigamePlayer.count(),
      items: players.map((x) => ({
        ...x,
        currentLobby: service.find(x.uuid)?.id ?? null,
        connectionState: service.clients.has(x.uuid)
          ? (service.find(x.uuid)?.members.find((m) => m.uuid === x.uuid)
              ?.connection ?? "CONNECTED")
          : "DISCONNECTED",
      })),
    };
  });
  app.get("/api/minigames/admin/games", guard, async () =>
    [...engines.values()].map((e) => ({
      id: e.id,
      icon: e.icon,
      minPlayers: e.minPlayers,
      maxPlayers: e.maxPlayers,
      usesTimer: e.usesTimer,
      usesGameScreen: e.usesGameScreen,
      startCountdownSeconds: e.startCountdownSeconds,
      defaults: validateConfig(e.id, {}),
    })),
  );
  app.get("/api/minigames/admin/content", guard, async (req) => {
    const q = parse(
      pagination.extend({
        kind: z.enum(["item", "word", "photo", "settings"]).optional(),
        search: z.string().max(100).optional(),
      }),
      req.query,
    );
    const where = {
      kind: q.kind,
      data: q.search ? { contains: q.search } : undefined,
    };
    return {
      total: await prisma.minigameContent.count({ where }),
      items: (
        await prisma.minigameContent.findMany({
          where,
          orderBy: { id: "asc" },
          take: q.limit,
          skip: q.offset,
        })
      ).map((x) => ({ ...x, data: JSON.parse(x.data) })),
    };
  });
  app.put("/api/minigames/admin/content/:id", mutate, async (req) => {
    const { id } = parse(
      z.object({ id: z.string().regex(/^[a-zA-Z0-9_:-]{1,100}$/) }),
      req.params,
    );
    const b = parse(
      z
        .object({
          kind: z.enum(["item", "word", "photo", "settings"]),
          enabled: z.boolean(),
          data: z.unknown(),
        })
        .strict(),
      req.body,
    );
    const data =
      b.kind === "item"
        ? parse(itemContentSchema, b.data)
        : b.kind === "word"
          ? parse(wordContentSchema, b.data)
          : b.kind === "photo"
            ? parse(photoContentSchema, b.data)
            : validateConfig(
                parse(z.enum([...engines.keys()] as [any, ...any[]]), id),
                parse(z.record(z.unknown()), b.data),
              );
    if (b.kind === "item")
      ensure((data as any).itemId === id, "ITEM_ID_MISMATCH");
    const previous = await prisma.minigameContent.findUnique({ where: { id } });
    ensure(!previous || previous.kind === b.kind, "CONTENT_KIND_IMMUTABLE");
    await service.serialize(async () => {
      await prisma.$transaction([
        prisma.minigameContent.upsert({
          where: { id },
          create: {
            id,
            kind: b.kind,
            enabled: b.enabled,
            data: JSON.stringify(data),
          },
          update: { enabled: b.enabled, data: JSON.stringify(data) },
        }),
        prisma.minigameEvent.create({
          data: {
            type: "ADMIN_CONTENT_UPDATED",
            details: JSON.stringify({ id, admin: req.session!.user.id }),
          },
        }),
      ]);
      service.content = await service.repository.content();
    });
    return { ok: true };
  });
  app.get("/api/minigames/admin/logs", guard, async (req) => {
    const q = parse(
      pagination.extend({
        lobby: z.string().uuid().optional(),
        player: z.string().uuid().optional(),
        game: z.string().max(30).optional(),
        type: z.string().max(80).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      }),
      req.query,
    );
    const where = {
      lobbyId: q.lobby,
      playerUuid: q.player,
      game: q.game,
      type: q.type,
      createdAt: {
        gte: q.from ? new Date(q.from) : undefined,
        lte: q.to ? new Date(q.to) : undefined,
      },
    };
    return {
      total: await prisma.minigameEvent.count({ where }),
      items: await prisma.minigameEvent.findMany({
        where,
        take: q.limit,
        skip: q.offset,
        orderBy: { createdAt: "desc" },
      }),
    };
  });
}
