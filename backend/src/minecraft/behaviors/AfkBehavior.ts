import type { Bot } from "mineflayer";
import type { Behavior } from "./Behavior.js";

/**
 * Keeps the bot from being kicked for inactivity by periodically performing
 * a small, harmless action (jump + look around). Does not move the bot away
 * from its spawn position — see MovementBehavior for actual walking.
 */
export class AfkBehavior implements Behavior {
  readonly name = "afk";
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly intervalSeconds: number) {}

  start(bot: Bot): void {
    this.stop();
    this.timer = setInterval(() => {
      try {
        const yaw = Math.random() * Math.PI * 2;
        const pitch = (Math.random() - 0.5) * 0.5;
        bot.look(yaw, pitch, false);
        bot.setControlState("jump", true);
        setTimeout(() => bot.setControlState("jump", false), 250);
      } catch {
        // Bot may have already disconnected between the tick firing and
        // running; safe to ignore, the next reconnect will restart this.
      }
    }, Math.max(5, this.intervalSeconds) * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
