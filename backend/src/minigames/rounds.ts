import type { Lobby } from "./protocol.js";
import { engine, type Context } from "./games/index.js";

export function activateRound(lobby: Lobby, context: Context) {
  lobby.state = "ACTIVE";
  lobby.startedAt ??= context.now;
  delete lobby.countdownEndsAt;
  delete lobby.preparingAt;
  engine(lobby.game).start(lobby, context);
}

/** Game policy owns the start delay; preparation and activation stay authoritative. */
export function prepareRound(lobby: Lobby, context: Context) {
  const game = engine(lobby.game);
  game.prepare(lobby, context);
  if (game.startCountdownSeconds === 0) {
    activateRound(lobby, context);
    return "GAME_STARTED";
  }
  lobby.state = "COUNTDOWN";
  lobby.countdownEndsAt = context.now + game.startCountdownSeconds * 1000;
  return "COUNTDOWN_STARTED";
}
