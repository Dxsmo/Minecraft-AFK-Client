import type { Bot } from "mineflayer";
import type { Behavior, BehaviorContext } from "./Behavior.js";

/**
 * Periodically sends a fixed, admin/user-configured chat message or command
 * for this specific account — independent from AFK/movement idling. Useful
 * for things like periodic `/hub`, keep-alive chat pings, or timed commands.
 */
export class AutoCommandBehavior implements Behavior {
  readonly name = "auto-command";
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly command: string,
    private readonly intervalMinutes: number,
  ) {}

  start(bot: Bot, context: BehaviorContext): void {
    this.stop();
    if (!this.command.trim()) return;

    const intervalMs = Math.max(1, this.intervalMinutes) * 60_000;
    this.timer = setInterval(() => {
      try {
        bot.chat(this.command);
        context.logEvent(`Auto-command sent: ${this.command}`);
      } catch {
        // Bot may have disconnected between the tick firing and running;
        // safe to ignore, the next reconnect will restart this behavior.
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
