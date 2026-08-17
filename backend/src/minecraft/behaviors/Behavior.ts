import type { Bot } from "mineflayer";

/** Shared context passed to every behavior when it starts. */
export interface BehaviorContext {
  /** Logs a console line for actions the behavior takes automatically (e.g. an auto-sent command). */
  logEvent: (message: string) => void;
}

/**
 * A Behavior encapsulates one piece of automated bot logic (AFK idling,
 * movement, etc.) that can be attached/detached independently from the core
 * connection logic in MinecraftClient. This keeps the client class focused
 * on connection lifecycle while behaviors stay small, testable, and easy to
 * extend with new ones in the future.
 */
export interface Behavior {
  readonly name: string;
  /** Called once when the bot spawns and the behavior should start acting. */
  start(bot: Bot, context: BehaviorContext): void;
  /** Called when the bot disconnects/the behavior should stop acting. */
  stop(): void;
}
