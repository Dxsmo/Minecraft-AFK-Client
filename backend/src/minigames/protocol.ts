import { z } from "zod";
import { randomInt } from "node:crypto";
export const PROTOCOL_VERSION = 1;
export const SUPPORTED_VERSIONS = [
  "1.21.11",
  "26.1",
  "26.1.1",
  "26.1.2",
  "26.2",
  "26.3",
];
export const gameIds = [
  "bingo",
  "hot_potato",
  "hide_seek",
  "item_hunt",
  "masterbuilders",
  "tictactoe",
  "connect_four",
  "memory",
  "rps",
  "photo_hunt",
  "collector",
] as const;
export type GameId = (typeof gameIds)[number];
export type Phase =
  | "LOBBY"
  | "PREPARING"
  | "COUNTDOWN"
  | "ACTIVE"
  | "ROUND_END"
  | "RESULTS"
  | "REMATCH"
  | "FINISHED";
export type Connection = "CONNECTED" | "TRANSFERRING" | "DISCONNECTED";
export type Status =
  | "ACTIVE"
  | "ELIMINATED"
  | "SPECTATING"
  | "DISCONNECTED"
  | "TRANSFERRING";
export const itemId = z
  .string()
  .regex(/^minecraft:[a-z0-9_]+$/)
  .max(100);
export const handshakeSchema = z
  .object({
    minecraftVersion: z.enum(SUPPORTED_VERSIONS as [string, ...string[]]),
    modVersion: z.string().min(1).max(32),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    itemCatalogVersion: z.string().min(1).max(32),
    playerUuid: z.string().uuid(),
    playerName: z.string().regex(/^[A-Za-z0-9_]{3,16}$/),
    logicalServerNetwork: z.string().regex(/^[A-Z0-9_.:-]{1,80}$/),
    capabilities: z.array(z.string().max(40)).max(30),
    itemIds: z.array(itemId).max(5000),
    streamerMode: z.boolean().default(false),
  })
  .strict();
export type Handshake = z.infer<typeof handshakeSchema>;
const base = {
  requestId: z.string().uuid(),
  sequence: z.number().int().positive(),
  timestamp: z.number().int().positive(),
};
const target = { target: z.string().uuid() };
const inventory = { items: z.array(itemId).max(200) };
export const eventSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("CREATE"),
    game: z.enum(gameIds),
    config: z
      .record(z.union([z.string().max(80), z.number().finite(), z.boolean()]))
      .default({}),
  }),
  z.object({
    ...base,
    type: z.literal("JOIN"),
    code: z
      .string()
      .length(8)
      .regex(/^[A-Za-z2-9#!?]+$/),
  }),
  z.object({
    ...base,
    type: z.enum([
      "LEAVE",
      "DISBAND",
      "START",
      "SNAPSHOT",
      "INVITE_LIST",
      "HEARTBEAT",
    ]),
  }),
  z.object({ ...base, type: z.literal("READY"), ready: z.boolean() }),
  z.object({ ...base, type: z.literal("SCREEN"), open: z.boolean() }),
  z.object({ ...base, type: z.literal("STREAMER"), enabled: z.boolean() }),
  z.object({
    ...base,
    type: z.literal("KICK"),
    ...target,
    ban: z.boolean().default(false),
  }),
  z.object({ ...base, type: z.literal("INVITE"), ...target }),
  z.object({
    ...base,
    type: z.literal("INVITE_REPLY"),
    inviteId: z.string().uuid(),
    accept: z.boolean(),
  }),
  z.object({
    ...base,
    type: z.literal("CONNECTION"),
    state: z.enum(["CONNECTED", "TRANSFERRING", "DISCONNECTED"]),
  }),
  z.object({ ...base, type: z.literal("INVENTORY"), ...inventory }),
  z.object({
    ...base,
    type: z.literal("MOVE"),
    slot: z.number().int().min(0).max(41),
  }),
  z.object({ ...base, type: z.literal("HIT"), ...target }),
  z.object({
    ...base,
    type: z.literal("POSITION"),
    x: z.number().finite().min(-3e7).max(3e7),
    y: z.number().finite().min(-2048).max(2048),
    z: z.number().finite().min(-3e7).max(3e7),
    dimension: z.string().max(80),
    elytra: z.boolean(),
  }),
  z.object({
    ...base,
    type: z.literal("GUESS"),
    word: z.string().min(1).max(80),
  }),
  z.object({
    ...base,
    type: z.literal("WORD"),
    index: z.number().int().min(0).max(4),
  }),
  z.object({
    ...base,
    type: z.literal("CHOICE"),
    choice: z.enum(["scissors", "rock", "paper"]),
  }),
  z.object({ ...base, type: z.literal("VOTE"), accept: z.boolean() }),
  z.object({ ...base, type: z.literal("REMATCH"), accept: z.boolean() }),
]);
export type Event = z.infer<typeof eventSchema>;
export interface Member {
  uuid: string;
  name: string;
  ready: boolean;
  connection: Connection;
  status: Status;
  minecraftVersion: string;
  modVersion: string;
  streamerMode: boolean;
  disconnectedAt?: number;
  transferringUntil?: number;
  screenClosedAt?: number;
  inventory: string[];
  inventoryAt?: number;
  catalog: string[];
  score: number;
  position?: {
    x: number;
    y: number;
    z: number;
    dimension: string;
    elytra: boolean;
    at: number;
  };
  metrics: Record<string, number>;
}
export interface Lobby {
  id: string;
  code: string;
  host: string;
  game: GameId;
  network: string;
  state: Phase;
  config: Record<string, string | number | boolean>;
  createdAt: number;
  startedAt?: number;
  roundStartedAt?: number;
  roundEndsAt?: number;
  countdownEndsAt?: number;
  revision: number;
  members: Member[];
  bans: string[];
  kicks: Record<string, number>;
  data: Record<string, any>;
  winners: string[];
  matchScores: Record<string, number>;
  round: number;
  pause?: { since: number; until: number; player: string };
  preparingAt?: number;
  retired?: Member[];
}
export class GameError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) throw new GameError(code);
}
export function member(l: Lobby, uuid: string) {
  const m = l.members.find((m) => m.uuid === uuid);
  ensure(m, "NOT_MEMBER");
  return m;
}
export function active(l: Lobby) {
  return l.members.filter((m) =>
    ["ACTIVE", "TRANSFERRING", "DISCONNECTED"].includes(m.status),
  );
}
export function finish(l: Lobby, winners: string[]) {
  l.winners = winners;
  l.state = "RESULTS";
  l.roundEndsAt = undefined;
  l.pause = undefined;
  l.data.outcome =
    winners.length === 0 || (winners.length > 1 && l.game !== "hide_seek")
      ? "DRAW"
      : "WIN";
  if (l.data.outcome === "WIN")
    for (const id of winners) l.matchScores[id] = (l.matchScores[id] ?? 0) + 1;
}
export function random<T>(a: T[]): T {
  ensure(a.length, "EMPTY_CONTENT_POOL");
  return a[randomInt(a.length)];
}
export function shuffle<T>(a: T[]): T[] {
  const copy = [...a];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
export function metric(m: Member, key: string, amount = 1) {
  m.metrics[key] = (m.metrics[key] ?? 0) + amount;
}
export function generateCode() {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789#!?";
  return Array.from(
    { length: 8 },
    () => alphabet[randomInt(alphabet.length)],
  ).join("");
}
