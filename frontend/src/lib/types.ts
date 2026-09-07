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
  role: Role;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
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
  health?: number;
  food?: number;
  position?: { x: number; y: number; z: number };
  lastError?: string;
  reconnectAttempt: number;
  connectedSince?: string;
  msaSignIn?: MsaSignInPrompt;
  authenticated?: boolean;
  balance?: number;
  balanceUpdatedAt?: string;
  homes?: string[];
}

export interface MinecraftAccount {
  id: string;
  name: string;
  displayName: string;
  minecraftVersion: string;
  serverHost: string;
  serverPort: number;
  edition: Edition;
  authType: AuthType;
  afkEnabled: boolean;
  movementEnabled: boolean;
  crouchEnabled: boolean;
  afkIntervalSeconds: number;
  autoReconnect: boolean;
  notes: string;
  autoCommandEnabled: boolean;
  autoCommandText: string;
  autoCommandIntervalMinutes: number;
  autoCommandSpanEnabled: boolean;
  autoCommandSpanMinSeconds: number;
  autoCommandSpanMaxSeconds: number;
  tpAutoEnabled: boolean;
  tpAutoAllowlist: string[];
  autoSellEnabled: boolean;
  autoSellIntervalSeconds: number;
  autoSellCommand: string;
  dailyCommandEnabled: boolean;
  dailyCommandTimes: string[];
  balanceEnabled: boolean;
  balanceCommand: string;
  lastBalance: number | null;
  lastBalanceAt: string | null;
  homes: string[];
  spawnerType: string;
  spawnerActions: Record<string, SpawnerAction>;
  spawnerClearEnabled: boolean;
  spawnerClearTimes: string[];
  dashboardOrder: number;
  status: ClientStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; username: string } | null;
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

// ---- Name Sniper (admin-only, fully independent of MinecraftAccount) ----

export interface SniperLiveStatus {
  id: string;
  status: ClientStatus;
  msaSignIn?: MsaSignInPrompt;
  authenticated?: boolean;
  lastError?: string;
  currentName?: string;
  lastAttemptAt?: string;
  lastResult?: string;
  lastSuccess?: boolean;
}

export interface SniperAccount {
  id: string;
  label: string;
  email: string;
  desiredName: string;
  cooldownSeconds: number;
  rateLimitProtection: boolean;
  proxies: string;
  enabled: boolean;
  status: ClientStatus;
  currentName: string | null;
  lastAttemptAt: string | null;
  lastResult: string | null;
  lastSuccess: boolean;
  dashboardOrder: number;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; username: string } | null;
  live?: SniperLiveStatus;
}

/** One item's scanned price, plus what the previous scan recorded for it. */
export interface ItemWorthValue {
  itemId: string;
  itemName: string;
  /** null means the server reports no configured price for this item. */
  value: number | null;
  previousValue: number | null;
  hasPrevious: boolean;
  /** True when this item's price differs from the previous scan. */
  changed: boolean;
  updatedAt: string;
}

export type ItemWorthStatus = "IDLE" | "RUNNING" | "PAUSED" | "COMPLETED" | "CANCELLED";

/** Progress and results of the admin-only `/worth` price scan. */
export interface ItemWorthState {
  status: ItemWorthStatus;
  cursor: number;
  total: number;
  scanNumber: number;
  changedCount: number;
  missedCount: number;
  lastItemId: string | null;
  lastError: string | null;
  /** False when the scan gave up; it will not resume by itself. */
  resumable: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  etaSeconds: number | null;
  registryTotal: number;
  values: ItemWorthValue[];
}
