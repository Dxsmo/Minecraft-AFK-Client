import { randomUUID } from "node:crypto";
import {
  type Lobby,
  type Handshake,
  type Event,
} from "../../src/minigames/protocol.js";
import {
  engine,
  validateConfig,
  type Context,
} from "../../src/minigames/games/index.js";
export const ids = [randomUUID(), randomUUID(), randomUUID()];
export function lobby(
  game: Lobby["game"],
  config: Record<string, unknown> = {},
  count = 2,
): Lobby {
  return {
    id: randomUUID(),
    code: "AbC2#?xy",
    host: ids[0],
    game,
    network: "SMP_MAIN_NETWORK",
    state: "ACTIVE",
    config: validateConfig(game, config),
    createdAt: Date.now(),
    revision: 0,
    members: ids.slice(0, count).map((uuid, i) => ({
      uuid,
      name: ["Desmodus", "Steve", "Alex"][i],
      ready: false,
      connection: "CONNECTED",
      status: "ACTIVE",
      minecraftVersion: "1.21.11",
      modVersion: "1.0.0",
      streamerMode: false,
      inventory: [],
      catalog: [],
      score: 0,
      metrics: {},
      position: {
        x: 0,
        y: 64,
        z: 0,
        dimension: "minecraft:overworld",
        elytra: false,
        at: Date.now(),
      },
    })),
    bans: [],
    kicks: {},
    data: {},
    winners: [],
    matchScores: {},
    round: 1,
  };
}
export function event(
  type: string,
  extra: Record<string, unknown> = {},
  now = Date.now(),
): Event {
  return {
    type,
    requestId: randomUUID(),
    sequence: 1,
    timestamp: now,
    ...extra,
  } as Event;
}
export function hello(uuid = ids[0], catalog: string[] = []): Handshake {
  return {
    minecraftVersion: "1.21.11",
    modVersion: "1.0.0",
    protocolVersion: 1,
    itemCatalogVersion: "1",
    playerUuid: uuid,
    playerName: uuid === ids[0] ? "Desmodus" : "Steve",
    logicalServerNetwork: "SMP_MAIN_NETWORK",
    capabilities: ["photo_consent"],
    itemIds: catalog,
    streamerMode: false,
  };
}
export const context: Context = {
  now: Date.now(),
  content: Array.from({ length: 80 }, (_, i) => ({
    id: "minecraft:item_" + i,
    kind: "item",
    enabled: true,
    data: {
      survivalObtainable: true,
      bingoEligible: true,
      itemHuntEligible: true,
      collectorEligible: true,
      difficulty: "LEICHT",
      supportedVersions: ["1.21.11", "26.3"],
      category: "OVERWORLD",
    },
  })),
};
export function start(l: Lobby, c = context) {
  for (const m of l.members)
    m.catalog = c.content.filter((x) => x.kind === "item").map((x) => x.id);
  engine(l.game).start(l, c);
}
