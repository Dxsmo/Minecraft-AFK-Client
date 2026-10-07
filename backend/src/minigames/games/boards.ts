import { z } from "zod";
import {
  active,
  ensure,
  finish,
  random,
  shuffle,
  metric,
  type Event,
  type Lobby,
  type Member,
} from "../protocol.js";
import { baseConfig, defaults, register, type GameEngine } from "./registry.js";
export function lineWinner(
  board: (string | null)[],
  width: number,
  height: number,
  length: number,
): string | null {
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = board[y * width + x];
      if (!v) continue;
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [1, 1],
        [1, -1],
      ]) {
        const ex = x + (length - 1) * dx,
          ey = y + (length - 1) * dy;
        if (ex < 0 || ex >= width || ey < 0 || ey >= height) continue;
        if (
          Array.from(
            { length },
            (_, i) => board[(y + i * dy) * width + x + i * dx],
          ).every((c) => c === v)
        )
          return v;
      }
    }
  return null;
}
export function turn(l: Lobby, m: Member) {
  ensure(!l.pause, "GAME_PAUSED");
  ensure(l.data.turn === m.uuid, "NOT_YOUR_TURN");
}
export function next(l: Lobby) {
  const ids = l.members.map((m) => m.uuid);
  l.data.turn = ids.find((id) => id !== l.data.turn);
}
function boardEngine(
  id: "tictactoe" | "connect_four",
  width: number,
  height: number,
  length: number,
  icon: string,
): GameEngine {
  return {
    ...defaults,
    id,
    icon,
    minPlayers: 2,
    maxPlayers: 2,
    usesTimer: false,
    usesGameScreen: true,
    startCountdownSeconds: 0,
    settings: z
      .object({ ...baseConfig, maxPlayers: z.literal(2).default(2) })
      .strict(),
    start(l) {
      l.data = {
        board: Array(width * height).fill(null),
        width,
        height,
        turn:
          l.data.firstStarter !== undefined
            ? l.members[
                (l.round - 1) % 2 === 0
                  ? l.data.firstStarter
                  : 1 - l.data.firstStarter
              ].uuid
            : random(l.members).uuid,
      };
      // Keep the first starter's index in persistent lobby data for alternating rematches.
      l.data.firstStarter =
        l.members.findIndex((m) => m.uuid === l.data.turn) ^ (l.round - 1) % 2;
    },
    handle(l, m, e) {
      ensure(e.type === "MOVE", "UNSUPPORTED_EVENT");
      turn(l, m);
      let slot = e.slot;
      if (id === "connect_four") {
        ensure(slot < width, "INVALID_SLOT");
        slot = -1;
        for (let y = height - 1; y >= 0; y--)
          if (!l.data.board[y * width + e.slot]) {
            slot = y * width + e.slot;
            break;
          }
      }
      ensure(
        slot >= 0 && slot < width * height && !l.data.board[slot],
        "INVALID_SLOT",
      );
      l.data.board[slot] = m.uuid;
      const winner = lineWinner(l.data.board, width, height, length);
      if (winner) finish(l, [winner]);
      else if (l.data.board.every(Boolean)) finish(l, []);
      else next(l);
    },
  };
}
register(boardEngine("tictactoe", 3, 3, 3, "minecraft:blue_concrete"));
register(boardEngine("connect_four", 7, 6, 4, "minecraft:redstone_lamp"));
register({
  ...defaults,
  id: "memory",
  icon: "minecraft:painting",
  minPlayers: 2,
  maxPlayers: 2,
  usesTimer: false,
  usesGameScreen: true,
  startCountdownSeconds: 0,
  settings: z
    .object({
      ...baseConfig,
      maxPlayers: z.literal(2).default(2),
      boardSize: z.enum(["4x4", "6x4", "6x6"]).default("6x4"),
    })
    .strict(),
  start(l, c) {
    const [width, height] = String(l.config.boardSize).split("x").map(Number);
    const ids = shuffle(
      c.content
        .filter(
          (x) =>
            x.kind === "item" &&
            x.enabled &&
            x.data.survivalObtainable &&
            l.members.every(
              (m) =>
                m.catalog.includes(x.id) &&
                x.data.supportedVersions.includes(m.minecraftVersion),
            ),
        )
        .map((x) => x.id),
    ).slice(0, (width * height) / 2);
    ensure(ids.length === (width * height) / 2, "INSUFFICIENT_CONTENT");
    l.data = {
      deck: shuffle([...ids, ...ids]),
      matched: [],
      revealed: [],
      turn: random(l.members).uuid,
      width,
      height,
    };
    for (const m of l.members) m.score = 0;
  },
  handle(l, m, e) {
    ensure(e.type === "MOVE", "UNSUPPORTED_EVENT");
    turn(l, m);
    ensure(!l.data.evaluateAt, "REVEAL_PENDING");
    ensure(
      e.slot < l.data.deck.length &&
        !l.data.matched.includes(e.slot) &&
        !l.data.revealed.includes(e.slot),
      "INVALID_SLOT",
    );
    l.data.revealed.push(e.slot);
    if (l.data.revealed.length === 2) {
      const [a, b] = l.data.revealed;
      if (l.data.deck[a] === l.data.deck[b]) {
        l.data.matched.push(a, b);
        m.score++;
        metric(m, "pairsFound");
        l.data.revealed = [];
        if (l.data.matched.length === l.data.deck.length) {
          const high = Math.max(...l.members.map((m) => m.score));
          finish(
            l,
            l.members.filter((m) => m.score === high).map((m) => m.uuid),
          );
        }
      } else l.data.evaluateAt = cNow(e);
    }
  },
  tick(l, c) {
    if (l.data.evaluateAt && c.now >= l.data.evaluateAt) {
      l.data.revealed = [];
      delete l.data.evaluateAt;
      next(l);
    }
  },
  serialize(l) {
    return {
      ...l.data,
      deck: (l.data.deck ?? []).map((id: string, i: number) =>
        l.data.matched.includes(i) || l.data.revealed.includes(i) ? id : null,
      ),
    };
  },
});
// The service replaces all event timestamps with its own reception timestamp.
function cNow(e: Event) {
  return e.timestamp + 1200;
}
export function rpsWinner(a: string, b: string): number {
  if (a === b) return 0;
  return (
    { rock: "scissors", scissors: "paper", paper: "rock" } as Record<
      string,
      string
    >
  )[a] === b
    ? 1
    : -1;
}
register({
  ...defaults,
  id: "rps",
  icon: "minecraft:shears",
  minPlayers: 2,
  maxPlayers: 2,
  usesTimer: false,
  usesGameScreen: true,
  startCountdownSeconds: 0,
  settings: z
    .object({
      ...baseConfig,
      maxPlayers: z.literal(2).default(2),
      bestOf: z
        .union([z.literal(1), z.literal(3), z.literal(5), z.literal(7)])
        .default(3),
    })
    .strict(),
  start(l) {
    l.data = { choices: {}, roundScores: {}, subround: 1 };
    for (const m of l.members) m.score = 0;
  },
  handle(l, m, e, c) {
    ensure(e.type === "CHOICE", "UNSUPPORTED_EVENT");
    ensure(!l.data.choices[m.uuid] && !l.data.revealEndsAt, "ALREADY_CHOSEN");
    l.data.choices[m.uuid] = e.choice;
    if (Object.keys(l.data.choices).length === 2)
      l.data.revealEndsAt = c.now + 3000;
  },
  tick(l, c) {
    if (
      l.data.revealEndsAt &&
      c.now >= l.data.revealEndsAt &&
      !l.data.resolved
    ) {
      const [a, b] = l.members;
      const win = rpsWinner(l.data.choices[a.uuid], l.data.choices[b.uuid]);
      const winner = win === 1 ? a : win === -1 ? b : null;
      if (winner) {
        winner.score++;
        metric(winner, "roundWins");
      }
      l.data.resolved = true;
      l.data.nextAt = c.now + 2500;
      if (
        winner &&
        winner.score >= Math.floor(Number(l.config.bestOf) / 2) + 1
      ) {
        metric(winner, "matchWins");
        finish(l, [winner.uuid]);
      }
    } else if (l.data.nextAt && c.now >= l.data.nextAt) {
      l.data = { choices: {}, subround: l.data.subround + 1 };
    }
  },
  serialize(l) {
    const d = structuredClone(l.data);
    if (!d.resolved)
      d.choices = Object.fromEntries(
        Object.keys(d.choices ?? {}).map((id) => [id, "chosen"]),
      );
    return d;
  },
});
