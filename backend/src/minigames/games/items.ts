import { z } from "zod";
import { isSurvivalItem } from "../item-policy.js";
import {
  ensure,
  active,
  finish,
  shuffle,
  metric,
  type Lobby,
  type Member,
} from "../protocol.js";
import {
  baseConfig,
  defaults,
  difficulty,
  register,
  timed,
  type Context,
} from "./registry.js";
export const forbiddenBingo =
  /(?:dragon_egg|elytra|enchanted_golden_apple|ancient_debris|gilded_blackstone|smithing_template|banner_pattern|netherite_upgrade|netherite_|nether_star|beacon|wither_skeleton_skull|trident|heavy_core|mace|totem_of_undying|music_disc|echo_shard|recovery_compass|enchanted_book)/;
export function eligibleItems(
  l: Lobby,
  c: Context,
  kind: "bingoEligible" | "itemHuntEligible" | "collectorEligible",
  intersection = true,
) {
  return c.content
    .filter(
      (x) =>
        x.kind === "item" &&
        x.enabled &&
        x.data.survivalObtainable &&
        isSurvivalItem(x.id) &&
        x.data[kind] &&
        (kind !== "bingoEligible" || !forbiddenBingo.test(x.id)) &&
        (l.config.difficulty === undefined ||
          l.config.difficulty === "MIXED" ||
          l.config.difficulty === x.data.difficulty) &&
        (!intersection ||
          l.members.every(
            (m) =>
              m.catalog.includes(x.id) &&
              x.data.supportedVersions.includes(m.minecraftVersion),
          )) &&
        (!l.config.dimensionFilter ||
          l.config.dimensionFilter === "ALL" ||
          x.data.category === l.config.dimensionFilter),
    )
    .map((x) => x.id);
}
export function freshPool(
  l: Lobby,
  c: Context,
  kind: "bingoEligible" | "itemHuntEligible",
  n: number,
) {
  const held = new Set(l.members.flatMap((m) => m.inventory));
  const pool = shuffle(eligibleItems(l, c, kind).filter((id) => !held.has(id)));
  ensure(pool.length >= n, "INSUFFICIENT_FRESH_ITEMS");
  return pool.slice(0, n);
}
export function bingoLines(fields: number[], size: number) {
  const set = new Set(fields);
  let lines = 0;
  for (let n = 0; n < size; n++) {
    if (
      Array.from({ length: size }, (_, i) => n * size + i).every((i) =>
        set.has(i),
      )
    )
      lines++;
    if (
      Array.from({ length: size }, (_, i) => i * size + n).every((i) =>
        set.has(i),
      )
    )
      lines++;
  }
  if (
    Array.from({ length: size }, (_, i) => i * size + i).every((i) =>
      set.has(i),
    )
  )
    lines++;
  if (
    Array.from({ length: size }, (_, i) => i * size + size - i - 1).every((i) =>
      set.has(i),
    )
  )
    lines++;
  return lines;
}
function highScore(l: Lobby, players = l.members) {
  const high = Math.max(...players.map((m) => m.score));
  finish(
    l,
    players.filter((m) => m.score === high).map((m) => m.uuid),
  );
}
register({
  ...defaults,
  id: "bingo",
  icon: "minecraft:filled_map",
  minPlayers: 2,
  maxPlayers: 10,
  usesTimer: true,
  usesGameScreen: false,
  settings: z
    .object({
      ...baseConfig,
      boardSize: z.union([z.literal(3), z.literal(4), z.literal(5)]).default(5),
      difficulty,
      winCondition: z
        .enum(["FIRST_LINE", "TWO_LINES", "FULL_BOARD", "LOCKOUT"])
        .default("FIRST_LINE"),
      boardDisplay: z.enum(["SCREEN", "HUD"]).default("SCREEN"),
    })
    .strict(),
  prepare(l, c) {
    const size = Number(l.config.boardSize);
    l.data = {
      items: freshPool(l, c, "bingoEligible", size * size),
      completed: {},
      owners: {},
    };
  },
  start(l, c) {
    this.prepare(l, c);
    timed(l, c.now);
  },
  handle(l, m, e) {
    ensure(e.type === "INVENTORY", "UNSUPPORTED_EVENT");
    const done: number[] = (l.data.completed[m.uuid] ??= []);
    for (const id of e.items) {
      const i = l.data.items.indexOf(id);
      if (i < 0 || done.includes(i)) continue;
      if (l.config.winCondition === "LOCKOUT" && l.data.owners[i]) continue;
      done.push(i);
      m.score++;
      metric(m, "fieldsCompleted");
      if (l.config.winCondition === "LOCKOUT") {
        l.data.owners[i] = m.uuid;
        metric(m, "lockoutFields");
      }
    }
    const size = Number(l.config.boardSize),
      lines = bingoLines(done, size);
    if (
      (l.config.winCondition === "FIRST_LINE" && lines >= 1) ||
      (l.config.winCondition === "TWO_LINES" && lines >= 2) ||
      (l.config.winCondition === "FULL_BOARD" && done.length === size * size)
    ) {
      metric(m, "bingosWon");
      finish(l, [m.uuid]);
    } else if (
      l.config.winCondition === "LOCKOUT" &&
      Object.keys(l.data.owners).length === size * size
    )
      highScore(l, active(l));
  },
  tick(l, c) {
    if (c.now >= (l.roundEndsAt ?? Infinity)) highScore(l, active(l));
  },
  disconnect(l, m) {
    m.status = "SPECTATING";
  },
});
register({
  ...defaults,
  id: "item_hunt",
  icon: "minecraft:diamond",
  minPlayers: 2,
  maxPlayers: 10,
  usesTimer: true,
  usesGameScreen: false,
  settings: z
    .object({
      ...baseConfig,
      difficulty,
      dimensionFilter: z
        .enum(["ALL", "NETHER", "END", "MOB", "STRUCTURE"])
        .default("ALL"),
    })
    .strict(),
  prepare(l, c) {
    l.data = { item: freshPool(l, c, "itemHuntEligible", 1)[0] };
  },
  start(l, c) {
    this.prepare(l, c);
    timed(l, c.now);
  },
  handle(l, m, e) {
    ensure(e.type === "INVENTORY", "UNSUPPORTED_EVENT");
    if (e.items.includes(l.data.item)) {
      metric(m, "itemsFound");
      finish(l, [m.uuid]);
    }
  },
  tick(l, c) {
    if (c.now >= (l.roundEndsAt ?? Infinity)) finish(l, []);
  },
  disconnect(l, m) {
    m.status = "SPECTATING";
  },
});
register({
  ...defaults,
  id: "collector",
  icon: "minecraft:bundle",
  minPlayers: 2,
  maxPlayers: 10,
  usesTimer: true,
  usesGameScreen: false,
  settings: z.object(baseConfig).strict(),
  start(l, c) {
    l.data = {
      startingItems: Object.fromEntries(
        l.members.map((m) => [m.uuid, [...m.inventory]]),
      ),
      collected: {},
      eligible: eligibleItems(l, c, "collectorEligible", false),
    };
    timed(l, c.now);
  },
  handle(l, m, e) {
    ensure(e.type === "INVENTORY", "UNSUPPORTED_EVENT");
    const items: string[] = (l.data.collected[m.uuid] ??= []);
    for (const id of e.items)
      if (
        l.data.eligible.includes(id) &&
        m.catalog.includes(id) &&
        !l.data.startingItems[m.uuid].includes(id) &&
        !items.includes(id)
      ) {
        items.push(id);
        m.score++;
        metric(m, "totalUniqueItemsCollected");
        m.metrics.highestUniqueItems = Math.max(
          m.metrics.highestUniqueItems ?? 0,
          m.score,
        );
      }
  },
  tick(l, c) {
    if (c.now >= (l.roundEndsAt ?? Infinity)) highScore(l);
  },
  disconnect(l, m) {
    m.status = "SPECTATING";
  },
  serialize(l, uuid) {
    const d = structuredClone(l.data);
    d.collected = { [uuid]: d.collected?.[uuid] ?? [] };
    delete d.eligible;
    delete d.startingItems;
    return d;
  },
});
