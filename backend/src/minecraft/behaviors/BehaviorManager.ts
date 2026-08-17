import type { Bot } from "mineflayer";
import type { Behavior } from "./Behavior.js";
import { AfkBehavior } from "./AfkBehavior.js";
import { MovementBehavior } from "./MovementBehavior.js";

export interface BehaviorConfig {
  afkEnabled: boolean;
  movementEnabled: boolean;
  afkIntervalSeconds: number;
}

/**
 * Owns the set of active Behaviors for a single MinecraftClient and starts /
 * stops them together, based on the account's configuration. Adding a new
 * behavior in the future only requires registering it here.
 */
export class BehaviorManager {
  private behaviors: Behavior[] = [];

  constructor(private config: BehaviorConfig) {}

  updateConfig(config: BehaviorConfig): void {
    this.config = config;
  }

  start(bot: Bot): void {
    this.stop();
    if (this.config.afkEnabled) {
      const afk = new AfkBehavior(this.config.afkIntervalSeconds);
      afk.start(bot);
      this.behaviors.push(afk);
    }
    if (this.config.movementEnabled) {
      const movement = new MovementBehavior();
      movement.start(bot);
      this.behaviors.push(movement);
    }
  }

  stop(): void {
    for (const behavior of this.behaviors) behavior.stop();
    this.behaviors = [];
  }
}
