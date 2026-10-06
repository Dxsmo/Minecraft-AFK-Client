import { z } from "zod";
import {
  ensure,
  type Event,
  type GameId,
  type Lobby,
  type Member,
} from "../protocol.js";
export interface Content {
  id: string;
  kind: string;
  enabled: boolean;
  data: any;
}
export interface Context {
  now: number;
  content: Content[];
}
export interface GameEngine {
  id: GameId;
  icon: string;
  minPlayers: number;
  maxPlayers: number;
  usesTimer: boolean;
  usesGameScreen: boolean;
  settings: z.ZodTypeAny;
  prepare(l: Lobby, c: Context): void;
  start(l: Lobby, c: Context): void;
  handle(l: Lobby, m: Member, e: Event, c: Context): void;
  tick(l: Lobby, c: Context): void;
  disconnect(l: Lobby, m: Member, c: Context): void;
  reconnect(l: Lobby, m: Member, c: Context): void;
  serialize(l: Lobby, uuid: string): Record<string, any>;
}
export const baseConfig = {
  maxPlayers: z.number().int().min(2).max(10).default(10),
  durationMinutes: z.number().int().min(1).max(1440).default(10),
};
export const difficulty = z
  .enum(["LEICHT", "MITTEL", "SCHWER", "MIXED"])
  .default("MIXED");
export const engines = new Map<GameId, GameEngine>();
export function register(engine: GameEngine) {
  ensure(!engines.has(engine.id), "DUPLICATE_GAME");
  engines.set(engine.id, engine);
}
export function engine(id: GameId) {
  const e = engines.get(id);
  ensure(e, "UNKNOWN_GAME");
  return e;
}
export function validateConfig(id: GameId, config: Record<string, unknown>) {
  const e = engine(id),
    parsed = e.settings.safeParse(config);
  ensure(parsed.success, "INVALID_CONFIG");
  return {
    ...parsed.data,
    maxPlayers: Math.min(e.maxPlayers, parsed.data.maxPlayers),
  } as Record<string, string | number | boolean>;
}
export function timed(l: Lobby, now: number) {
  l.roundStartedAt = now;
  l.roundEndsAt = now + Number(l.config.durationMinutes) * 60000;
}
export function publicData(l: Lobby) {
  return structuredClone(l.data);
}
export const defaults = {
  prepare: () => {},
  start: () => {},
  handle: () => {
    throw new Error("UNSUPPORTED_EVENT");
  },
  tick: () => {},
  disconnect: () => {},
  reconnect: () => {},
  serialize: publicData,
};
