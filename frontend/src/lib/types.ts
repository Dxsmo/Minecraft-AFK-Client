export type Role = "ADMIN" | "USER";
export type UserStatus = "ACTIVE" | "DISABLED";
export type AuthType = "OFFLINE" | "MICROSOFT";
export type ClientStatus =
  | "OFFLINE"
  | "CONNECTING"
  | "ONLINE"
  | "DISCONNECTING"
  | "RECONNECTING"
  | "ERROR";
export type ConsoleLogType =
  | "SYSTEM"
  | "CHAT"
  | "SERVER_MESSAGE"
  | "USER_COMMAND"
  | "ERROR"
  | "WARNING";

export interface CurrentUser {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
}

export interface ManagedUser {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface LiveStatus {
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
}

export interface MinecraftAccount {
  id: string;
  name: string;
  minecraftVersion: string;
  serverHost: string;
  serverPort: number;
  authType: AuthType;
  afkEnabled: boolean;
  movementEnabled: boolean;
  afkIntervalSeconds: number;
  autoReconnect: boolean;
  status: ClientStatus;
  createdAt: string;
  updatedAt: string;
  assignments: { userId: string; user: { id: string; username: string } }[];
  live?: LiveStatus;
}

export interface ConsoleLogEntry {
  id: string;
  minecraftAccountId: string;
  type: ConsoleLogType;
  message: string;
  createdAt: string;
}

export interface SystemStatus {
  uptimeSeconds: number;
  systemUptimeSeconds: number;
  cpu: { loadAvg1m: number; cores: number };
  memory: { totalBytes: number; freeBytes: number; usedBytes: number };
  clients: { total: number; online: number; offline: number; error: number };
}
