import type { ClientStatus, ConsoleEventType, MsaSignInPrompt } from "../minecraft/types.js";

// Reuses the exact same status/console-log-type enums as the Minecraft
// clients (see ../minecraft/types.ts) so the existing StatusBadge/ConsoleView
// frontend components work completely unmodified for the Name Sniper feature.
export type { ClientStatus, ConsoleEventType, MsaSignInPrompt };

export interface SniperConsoleEvent {
  sniperAccountId: string;
  type: ConsoleEventType;
  message: string;
  timestamp: string;
}

export interface SniperRuntimeConfig {
  id: string;
  email: string;
  desiredName: string;
  cooldownSeconds: number;
  /** When true, the Rust subprocess backs off on HTTP 429 (rate limited)
   * instead of retrying at the normal cooldown. */
  rateLimitProtection: boolean;
}

export interface SniperStatusSnapshot {
  id: string;
  status: ClientStatus;
  msaSignIn?: MsaSignInPrompt;
  /** True once the Microsoft profile has been resolved (device-code sign-in completed). */
  authenticated?: boolean;
  lastError?: string;
  /** The account's current in-game name, once known. */
  currentName?: string;
  lastAttemptAt?: string;
  lastResult?: string;
  lastSuccess?: boolean;
}
