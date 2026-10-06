import { handleCommand } from "./commands.js";
import { tickService } from "./scheduler.js";
import { rm } from "node:fs/promises";
import path from "node:path";
import { photoRoot } from "./storage.js";
import { logger } from "../logging/logger.js";
import { prisma } from "../database/prisma.js";
import {
  ensure,
  finish,
  member,
  type Event,
  type Handshake,
  type Lobby,
  type Member,
} from "./protocol.js";
import { engine, type Content } from "./games/index.js";
import { MinigameRepository, type Audit } from "./repository.js";
export type Sender = (message: unknown) => void;
interface Client {
  hello: Handshake;
  send: Sender;
  lastSeen: number;
  connectionId: string;
}
interface Invite {
  id: string;
  lobby: string;
  host: string;
  target: string;
  createdAt: number;
}
export class MinigameService {
  lobbies = new Map<string, Lobby>();
  clients = new Map<string, Client>();
  content: Content[] = [];
  invites = new Map<string, Invite>();
  private queue: Promise<unknown> = Promise.resolve();
  readonly limits = new Map<string, number[]>();
  readonly inviteTimes = new Map<string, number>();
  constructor(
    public repository = new MinigameRepository(),
    readonly now: () => number = Date.now,
  ) {}
  serialize<T>(action: () => Promise<T>): Promise<T> {
    const task = this.queue.then(action);
    this.queue = task.catch(() => {});
    return task;
  }
  async init() {
    this.content = await this.repository.content();
    const recentInvites = await prisma.minigameEvent.findMany({
      where: {
        type: "INVITE_SENT",
        createdAt: { gte: new Date(this.now() - 60000) },
      },
    });
    for (const e of recentInvites) {
      const target = JSON.parse(e.details).target;
      if (e.playerUuid && target)
        this.inviteTimes.set(
          e.playerUuid + ":" + target,
          e.createdAt.getTime(),
        );
    }
    for (const l of await this.repository.load()) {
      for (const m of l.members) {
        m.connection = "DISCONNECTED";
        m.disconnectedAt = this.now();
        if (m.status === "ACTIVE") m.status = "DISCONNECTED";
      }
      if (engine(l.game).maxPlayers === 2 && l.state === "ACTIVE")
        l.pause = {
          since: this.now(),
          until: this.now() + 60000,
          player: l.host,
        };
      this.lobbies.set(l.id, l);
    }
    await prisma.minigamePlayer.updateMany({
      data: { connectionState: "DISCONNECTED" },
    });
  }
  find(uuid: string) {
    return [...this.lobbies.values()].find(
      (l) => l.state !== "FINISHED" && l.members.some((m) => m.uuid === uuid),
    );
  }
  limit(uuid: string, kind: string, count: number, window = 60000) {
    const key = uuid + ":" + kind,
      now = this.now();
    const values = (this.limits.get(key) ?? []).filter((t) => t > now - window);
    ensure(values.length < count, "RATE_LIMITED");
    values.push(now);
    this.limits.set(key, values);
  }
  async connect(hello: Handshake, send: Sender, connectionId: string) {
    return this.serialize(async () => {
      const currentLobby = this.find(hello.playerUuid);
      if (currentLobby) {
        ensure(
          currentLobby.network === hello.logicalServerNetwork,
          "WRONG_NETWORK",
        );
        const objectives =
          currentLobby.game === "item_hunt"
            ? [currentLobby.data.item].filter(Boolean)
            : (currentLobby.data.items ?? []);
        ensure(
          currentLobby.state === "LOBBY" ||
            objectives.every((id: string) => hello.itemIds.includes(id)),
          "CATALOG_INCOMPATIBLE",
        );
      }
      const previous = this.clients.get(hello.playerUuid);

      const backup = currentLobby ? structuredClone(currentLobby) : undefined;
      try {
        this.clients.set(hello.playerUuid, {
          hello,
          send,
          lastSeen: this.now(),
          connectionId,
        });
        await prisma.minigamePlayer.upsert({
          where: { uuid: hello.playerUuid },
          create: {
            uuid: hello.playerUuid,
            name: hello.playerName,
            minecraftVersion: hello.minecraftVersion,
            modVersion: hello.modVersion,
            protocolVersion: hello.protocolVersion,
            network: hello.logicalServerNetwork,
            capabilities: JSON.stringify(hello.capabilities),
            itemIds: JSON.stringify(hello.itemIds),
            streamerMode: hello.streamerMode,
            connectionState: "CONNECTED",
          },
          update: {
            name: hello.playerName,
            minecraftVersion: hello.minecraftVersion,
            modVersion: hello.modVersion,
            protocolVersion: hello.protocolVersion,
            network: hello.logicalServerNetwork,
            capabilities: JSON.stringify(hello.capabilities),
            itemIds: JSON.stringify(hello.itemIds),
            streamerMode: hello.streamerMode,
            connectionState: "CONNECTED",
            lastSeen: new Date(this.now()),
          },
        });
        const l = this.find(hello.playerUuid);
        if (l) {
          ensure(l.network === hello.logicalServerNetwork, "WRONG_NETWORK");
          const m = member(l, hello.playerUuid);
          m.catalog = hello.itemIds;
          m.minecraftVersion = hello.minecraftVersion;
          m.modVersion = hello.modVersion;
          m.name = hello.playerName;
          m.streamerMode = hello.streamerMode;
          this.reconnected(l, m);
          await this.commit(l, [
            { type: "PLAYER_RECONNECTED", playerUuid: m.uuid },
          ]);
        }
        previous?.send({ type: "SESSION_REPLACED" });
        send({
          type: "WELCOME",
          protocolVersion: 1,
          serverTime: this.now(),
          games: [...new Set([...this.lobbies.values()].map((l) => l.game))],
        });
        this.snapshot(hello.playerUuid);
      } catch (err) {
        if (previous) this.clients.set(hello.playerUuid, previous);
        else this.clients.delete(hello.playerUuid);
        if (backup) this.lobbies.set(backup.id, backup);
        throw err;
      }
    });
  }
  async disconnect(uuid: string, connectionId: string) {
    return this.serialize(async () => {
      if (this.clients.get(uuid)?.connectionId !== connectionId) return;
      this.clients.delete(uuid);
      await prisma.minigamePlayer.updateMany({
        where: { uuid },
        data: {
          connectionState: "DISCONNECTED",
          lastSeen: new Date(this.now()),
        },
      });
      const l = this.find(uuid);
      if (!l) return;
      const m = member(l, uuid);
      if (m.connection !== "TRANSFERRING") {
        m.connection = "TRANSFERRING";
        m.transferringUntil = this.now() + 10000;
        if (m.status === "ACTIVE") m.status = "TRANSFERRING";
      }
      await this.commit(l, [{ type: "CONNECTION_HANDOFF", playerUuid: uuid }]);
    });
  }
  reconnected(l: Lobby, m: Member) {
    engine(l.game).reconnect(l, m, this.context());
    m.connection = "CONNECTED";
    m.disconnectedAt = undefined;
    m.transferringUntil = undefined;
    if (m.status === "DISCONNECTED" || m.status === "TRANSFERRING")
      m.status = "ACTIVE";
    if (l.pause && l.members.every((m) => m.connection === "CONNECTED")) {
      const elapsed = this.now() - l.pause.since;
      if (l.roundEndsAt) l.roundEndsAt += elapsed;
      for (const key of ["evaluateAt", "revealEndsAt", "nextAt"])
        if (l.data[key]) l.data[key] += elapsed;
      delete l.pause;
    }
  }
  async handle(uuid: string, event: Event, connectionId?: string) {
    return handleCommand(this, uuid, event, connectionId);
  }
  newMember(h: Handshake): Member {
    return {
      uuid: h.playerUuid,
      name: h.playerName,
      ready: false,
      connection: "CONNECTED",
      status: "ACTIVE",
      minecraftVersion: h.minecraftVersion,
      modVersion: h.modVersion,
      streamerMode: h.streamerMode,
      inventory: [],
      catalog: h.itemIds,
      score: 0,
      metrics: {},
    };
  }
  join(l: Lobby, h: Handshake) {
    ensure(l.state === "LOBBY", "GAME_ALREADY_STARTED");
    ensure(l.network === h.logicalServerNetwork, "WRONG_NETWORK");
    ensure(!l.bans.includes(h.playerUuid), "LOBBY_BANNED");
    ensure(l.members.length < Number(l.config.maxPlayers), "LOBBY_FULL");
    if (l.game === "photo_hunt")
      ensure(
        h.capabilities.includes("photo_consent"),
        "PHOTO_CONSENT_REQUIRED",
      );
    l.members.push(this.newMember(h));
  }
  remove(l: Lobby, m: Member) {
    if (l.state !== "LOBBY") {
      l.retired ??= [];
      l.retired.push(structuredClone(m));
      if (engine(l.game).maxPlayers === 2) {
        finish(
          l,
          l.members.filter((x) => x.uuid !== m.uuid).map((x) => x.uuid),
        );
      } else engine(l.game).disconnect(l, m, this.context());
    }
    l.members = l.members.filter((x) => x.uuid !== m.uuid);
  }
  context() {
    return { now: this.now(), content: this.content };
  }
  snapshot(uuid: string) {
    const l = this.find(uuid);
    this.clients.get(uuid)?.send({
      type: "SNAPSHOT",
      serverTime: this.now(),
      lobby: l ? this.publicSnapshot(l, uuid) : null,
    });
  }
  publicSnapshot(l: Lobby, uuid: string) {
    const { retired, ...visible } = l;
    return {
      ...visible,
      data: engine(l.game).serialize(l, uuid),
      members: l.members.map(
        ({ inventory, catalog, position, metrics, inventoryAt, ...m }) => m,
      ),
    };
  }
  async commit(
    l: Lobby,
    events: Audit[],
    receipt?: { id: string; player: string; hash: string },
  ) {
    if (
      l.data.lastSubmission &&
      l.data.loggedSubmission !== l.data.lastSubmission.id
    ) {
      const s = l.data.lastSubmission;
      events.push({
        type: s.accepted ? "SCREENSHOT_ACCEPTED" : "SCREENSHOT_REJECTED",
        playerUuid: s.player,
        details: { id: s.id },
      });
      l.data.loggedSubmission = s.id;
    }
    l.revision++;
    await this.repository.persist(l, events, receipt);
    for (const event of events)
      if (
        [
          "LOBBY_CREATED",
          "PLAYER_JOINED",
          "PLAYER_LEFT",
          "PLAYER_KICKED",
          "PLAYER_BANNED",
          "GAME_STARTED",
          "GAME_FINISHED",
          "HOST_MIGRATED",
          "ADMIN_CLOSED_LOBBY",
          "SCREENSHOT_SUBMITTED",
          "SCREENSHOT_ACCEPTED",
          "SCREENSHOT_REJECTED",
        ].includes(event.type)
      )
        logger.info(
          {
            lobbyId: l.id,
            game: l.game,
            eventType: event.type,
            playerUuid: event.playerUuid,
            requestId: receipt?.id,
          },
          "Minigame event",
        );
    if (l.state === "FINISHED") {
      for (const m of l.members)
        this.clients.get(m.uuid)?.send({
          type: "LOBBY_CLOSED",
          reason: events.at(-1)?.type ?? "FINISHED",
        });
      this.lobbies.delete(l.id);
      await rm(path.join(photoRoot, l.id), {
        recursive: true,
        force: true,
      }).catch((err) =>
        logger.error({ err, lobbyId: l.id }, "Minigame photo cleanup failed"),
      );
    } else for (const m of l.members) this.snapshot(m.uuid);
  }
  async tick() {
    return tickService(this);
  }
  async closeByAdmin(id: string, admin: string) {
    return this.serialize(async () => {
      const l = this.lobbies.get(id);
      ensure(l, "LOBBY_NOT_FOUND");
      l.state = "FINISHED";
      await this.commit(l, [
        { type: "ADMIN_CLOSED_LOBBY", details: { admin } },
      ]);
    });
  }
}
