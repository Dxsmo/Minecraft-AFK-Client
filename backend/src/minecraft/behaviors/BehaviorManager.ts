import type { Bot } from "mineflayer";
import type { Behavior, BehaviorContext } from "./Behavior.js";
import { AfkBehavior } from "./AfkBehavior.js";
import { MovementBehavior } from "./MovementBehavior.js";
import { AutoCommandBehavior } from "./AutoCommandBehavior.js";

export interface BehaviorConfig {
  afkEnabled: boolean;
  movementEnabled: boolean;
  afkIntervalSeconds: number;
  autoCommandEnabled: boolean;
  autoCommandText: string;
  autoCommandIntervalMinutes: number;
}

/**
 * Owns the set of active Behaviors for a single MinecraftClient and starts /
 * stops them together, based on the account's configuration. Adding a new
 * behavior in the future only requires registering it here.
 */
export class BehaviorManager {
  private behaviors: Behavior[] = [];

  constructor(
    private config: BehaviorConfig,
    private readonly logEvent: (message: string) => void,
  ) {}

  updateConfig(config: BehaviorConfig): void {
    this.config = config;
  }

  start(bot: Bot): void {
    this.stop();
    const context: BehaviorContext = { logEvent: this.logEvent };

    if (this.config.afkEnabled) {
      const afk = new AfkBehavior(this.config.afkIntervalSeconds);
      afk.start(bot, context);
      this.behaviors.push(afk);
    }
    if (this.config.movementEnabled) {
      const movement = new MovementBehavior();
      movement.start(bot, context);
      this.behaviors.push(movement);
    }
    if (this.config.autoCommandEnabled && this.config.autoCommandText.trim()) {
      const autoCommand = new AutoCommandBehavior(this.config.autoCommandText, this.config.autoCommandIntervalMinutes);
      autoCommand.start(bot, context);
      this.behaviors.push(autoCommand);
    }
  }

  stop(): void {
    for (const behavior of this.behaviors) behavior.stop();
    this.behaviors = [];
  }
}
