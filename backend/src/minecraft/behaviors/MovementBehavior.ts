import type { Bot } from "mineflayer";
import type { Behavior, BehaviorContext } from "./Behavior.js";

const STEP_INTERVAL_MS = 8000;
const WANDER_RADIUS_TICKS = 10; // roughly how many ticks to walk before turning

/**
 * Makes the bot wander a short distance around its current position at
 * intervals, so it looks more like a real (if idle) player and helps evade
 * some naive AFK-detection systems. Intentionally simple/dependency-free
 * (no pathfinding library) to keep resource usage low on a Raspberry Pi.
 */
export class MovementBehavior implements Behavior {
  readonly name = "movement";
  private timer: NodeJS.Timeout | null = null;

  start(bot: Bot, _context: BehaviorContext): void {
    this.stop();
    this.timer = setInterval(() => {
      try {
        const directions: Array<"forward" | "back" | "left" | "right"> = [
          "forward",
          "back",
          "left",
          "right",
        ];
        const direction = directions[Math.floor(Math.random() * directions.length)];

        bot.setControlState(direction, true);
        setTimeout(() => {
          try {
            bot.setControlState(direction, false);
          } catch {
            /* bot may have disconnected */
          }
        }, WANDER_RADIUS_TICKS * 100);
      } catch {
        /* bot may have disconnected */
      }
    }, STEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
