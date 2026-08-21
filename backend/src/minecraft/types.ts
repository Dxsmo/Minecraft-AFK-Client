/**
 * Public status values for a Minecraft client, mirrored 1:1 with the
 * `ClientStatus` enum in prisma/schema.prisma.
 */
export type ClientStatus =
  | "OFFLINE"
  | "CONNECTING"
  | "ONLINE"
  | "DISCONNECTING"
  | "RECONNECTING"
  | "ERROR";

export type ConsoleEventType =
  | "SYSTEM"
  | "CHAT"
  | "SERVER_MESSAGE"
  | "USER_COMMAND"
  | "ERROR"
  | "WARNING";

export interface ConsoleEvent {
  minecraftAccountId: string;
  type: ConsoleEventType;
  message: string;
  timestamp: string;
}

/** Emitted once the Rust bot resolves the real Minecraft profile (username/uuid). */
export interface ProfileEvent {
  minecraftAccountId: string;
  username: string;
  uuid: string;
}

export interface ClientRuntimeConfig {
  id: string;
  name: string;
  minecraftVersion: string;
  serverHost: string;
  serverPort: number;
  /** Which bot binary drives this account: Java (Azalea) or Bedrock (bedrock-protocol). */
  edition: "JAVA" | "BEDROCK";
  authType: "OFFLINE" | "MICROSOFT";
  /** Microsoft account email, only relevant when authType === "MICROSOFT". Never exposed to the frontend. */
  credentialsSecret: string | null;
  /** Microsoft account password, only relevant when authType === "MICROSOFT". Never exposed to the frontend. */
  credentialsPassword: string | null;
  afkEnabled: boolean;
  movementEnabled: boolean;
  crouchEnabled: boolean;
  afkIntervalSeconds: number;
  autoReconnect: boolean;
  autoCommandEnabled: boolean;
  autoCommandText: string;
  autoCommandIntervalMinutes: number;
  autoCommandSpanEnabled: boolean;
  autoCommandSpanMinSeconds: number;
  autoCommandSpanMaxSeconds: number;
  /** Auto-accept incoming /tpa teleport requests (never /tpahere). */
  tpAutoEnabled: boolean;
  /** Only auto-accept /tpa from these Minecraft names; empty = accept anyone. */
  tpAutoAllowlist: string[];
  /** Periodically run the sell command and move all items into the sell menu. */
  autoSellEnabled: boolean;
  autoSellIntervalSeconds: number;
  autoSellCommand: string;
  /** Fire the auto-command text at fixed times of day (see dailyCommandTimes). */
  dailyCommandEnabled: boolean;
  /** Times of day ("HH:MM", server local time) to run the auto-command once each. */
  dailyCommandTimes: string[];
  /** Periodically query and display the player's balance. */
  balanceEnabled: boolean;
  /** Command used to query the balance (e.g. "/balance"). */
  balanceCommand: string;
  /** Persisted /homes names from previous joins. */
  homes: string[];
}

/** Microsoft device-code sign-in details, shown live in the account console/UI. */
export interface MsaSignInPrompt {
  verificationUri: string;
  userCode: string;
  message: string;
  expiresAt: string;
}

export interface ClientStatusSnapshot {
  id: string;
  name: string;
  status: ClientStatus;
  serverHost: string;
  serverPort: number;
  health?: number;
  food?: number;
  position?: { x: number; y: number; z: number };
  lastError?: string;
  reconnectAttempt: number;
  connectedSince?: string;
  msaSignIn?: MsaSignInPrompt;
  /** True once the Microsoft profile has been resolved (device-code sign-in completed). */
  authenticated?: boolean;
  /** Last known player balance, when balance polling is enabled. */
  balance?: number;
  /** ISO timestamp of the last balance update. */
  balanceUpdatedAt?: string;
  /** Last discovered /homes names for this account. */
  homes?: string[];
}

/** A single occupied inventory slot in a live inventory snapshot. */
export interface InventoryItem {
  id: string;
  count: number;
}

/**
 * A live snapshot of a bot's own inventory. `main` is the 27 storage slots,
 * `hotbar` the 9 hotbar slots, `armor` the 4 armor slots; each entry is `null`
 * for an empty slot. `mutable` is true only when move/drop actions are accepted
 * (i.e. no container GUI is currently open).
 */
export interface InventorySnapshot {
  main: (InventoryItem | null)[];
  hotbar: (InventoryItem | null)[];
  offhand: InventoryItem | null;
  armor: (InventoryItem | null)[];
  mutable: boolean;
  /** ISO timestamp of when this snapshot was received from the bot. */
  updatedAt: string;
}
