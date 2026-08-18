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
  authType: "OFFLINE" | "MICROSOFT";
  /** Microsoft account email, only relevant when authType === "MICROSOFT". Never exposed to the frontend. */
  credentialsSecret: string | null;
  /** Microsoft account password, only relevant when authType === "MICROSOFT". Never exposed to the frontend. */
  credentialsPassword: string | null;
  afkEnabled: boolean;
  movementEnabled: boolean;
  afkIntervalSeconds: number;
  autoReconnect: boolean;
  autoCommandEnabled: boolean;
  autoCommandText: string;
  autoCommandIntervalMinutes: number;
  /** Auto-accept incoming /tpa teleport requests (never /tpahere). */
  tpAutoEnabled: boolean;
  /** Periodically run the sell command and move all items into the sell menu. */
  autoSellEnabled: boolean;
  autoSellIntervalSeconds: number;
  autoSellCommand: string;
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
}
