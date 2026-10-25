import type { SpawnerAction } from "./spawners";

export type Role = "ADMIN" | "USER";
export type UserStatus = "ACTIVE" | "DISABLED";
export type AuthType = "OFFLINE" | "MICROSOFT";
export type Edition = "JAVA" | "BEDROCK";
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
  minecraftUsername: string | null;
  role: Role;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface DashboardPreferences {
  accountOrder: string[];
  blurredAccountIds: string[];
  uploaderOrder: string[];
  collapsedUploaderIds: string[];
}

export interface BannedIp {
  ip: string;
  reason: string | null;
  auto: boolean;
  createdAt: string;
  createdBy: { id: string; username: string } | null;
}

export interface MsaSignInPrompt {
  verificationUri: string;
  userCode: string;
  message: string;
  expiresAt: string;
}

export interface LiveStatus {
  id: string;
  name: string;
  status: ClientStatus;
  serverHost: string;
  serverPort: number;
  position?: { x: number; y: number; z: number };
  lastError?: string;
  connectedSince?: string;
  msaSignIn?: MsaSignInPrompt;
  authenticated?: boolean;
}

export interface MinecraftAccount {
  id: string;
  imageUrl: string | null;
  name: string;
  displayName: string;
  minecraftVersion: string;
  serverHost: string;
  serverPort: number;
  edition: Edition;
  authType: AuthType;
  crouchEnabled: boolean;
  autoReconnect: boolean;
  notes: string;
  autoSellEnabled: boolean;
  autoSellIntervalSeconds: number;
  autoSellCommand: string;
  lastSellAt: string | null;
  spawnerType: string;
  spawnerActions: Record<string, SpawnerAction>;
  dashboardOrder: number;
  status: ClientStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; username: string; minecraftUsername: string | null } | null;
  assignments: { userId: string; user: { id: string; username: string } }[];
  live?: LiveStatus;
}

export type DashboardAccount = Pick<MinecraftAccount,
  "id" | "name" | "displayName" | "minecraftVersion" | "serverHost" | "serverPort" |
  "edition" | "notes" | "status" | "lastSellAt" | "imageUrl" | "createdBy" | "live">;

export interface ConsoleLogEntry {
  id: string;
  minecraftAccountId: string;
  type: ConsoleLogType;
  message: string;
  createdAt: string;
}

export interface EarningsHistory {
  range: "30m" | "1h" | "6h" | "24h";
  start: string;
  end: string;
  bucketMs: number;
  total: number;
  points: { at: string; amount: number }[];
}

export interface SystemStatus {
  uptimeSeconds: number;
  systemUptimeSeconds: number;
  cpu: { loadAvg1m: number; cores: number };
  memory: { totalBytes: number; freeBytes: number; usedBytes: number };
  clients: { total: number; online: number; offline: number; error: number };
}
