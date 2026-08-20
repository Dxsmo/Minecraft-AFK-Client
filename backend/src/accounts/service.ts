import { prisma } from "../database/prisma.js";
import type { CreateAccountInput, UpdateAccountInput } from "./schemas.js";
import type { SessionContext } from "../auth/session.js";

/** Parses the JSON-encoded tpAuto allowlist column into a string array. */
export function parseAllowlist(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Parses the JSON-encoded daily-command times column into a string array. */
export function parseDailyTimes(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Presents a stored account to API clients, decoding JSON-encoded list columns to arrays. */
function present<T extends { tpAutoAllowlist: string; dailyCommandTimes: string }>(
  account: T,
): Omit<T, "tpAutoAllowlist" | "dailyCommandTimes"> & { tpAutoAllowlist: string[]; dailyCommandTimes: string[] } {
  return {
    ...account,
    tpAutoAllowlist: parseAllowlist(account.tpAutoAllowlist),
    dailyCommandTimes: parseDailyTimes(account.dailyCommandTimes),
  };
}

/**
 * Fields safe to expose to any authorized viewer. `credentialsSecret` is
 * intentionally excluded so Minecraft credentials never reach the frontend,
 * satisfying the "no sensitive Minecraft credentials to the client" requirement.
 */
const publicAccountSelect = {
  id: true,
  name: true,
  displayName: true,
  minecraftVersion: true,
  serverHost: true,
  serverPort: true,
  edition: true,
  authType: true,
  afkEnabled: true,
  movementEnabled: true,
  crouchEnabled: true,
  afkIntervalSeconds: true,
  autoReconnect: true,
  notes: true,
  autoCommandEnabled: true,
  autoCommandText: true,
  autoCommandIntervalMinutes: true,
  tpAutoEnabled: true,
  tpAutoAllowlist: true,
  autoSellEnabled: true,
  autoSellIntervalSeconds: true,
  autoSellCommand: true,
  dailyCommandEnabled: true,
  dailyCommandTimes: true,
  balanceEnabled: true,
  balanceCommand: true,
  lastBalance: true,
  lastBalanceAt: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, username: true } },
  assignments: {
    select: { userId: true, user: { select: { id: true, username: true } } },
  },
} as const;

export async function listAccountsForSession(session: SessionContext) {
  const accounts =
    session.user.role === "ADMIN"
      ? await prisma.minecraftAccount.findMany({ select: publicAccountSelect, orderBy: { name: "asc" } })
      : await prisma.minecraftAccount.findMany({
          where: { assignments: { some: { userId: session.user.id } } },
          select: publicAccountSelect,
          orderBy: { name: "asc" },
        });
  return accounts.map(present);
}

export async function getAccountForSession(session: SessionContext, id: string) {
  const account = await prisma.minecraftAccount.findUnique({ where: { id }, select: publicAccountSelect });
  if (!account) return null;
  if (session.user.role !== "ADMIN" && !account.assignments.some((a) => a.userId === session.user.id)) {
    return null;
  }
  return present(account);
}

/** Returns true if the session's user may operate (start/stop/command/etc.) this account. */
export async function canAccessAccount(session: SessionContext, id: string): Promise<boolean> {
  if (session.user.role === "ADMIN") return true;
  const assignment = await prisma.userMinecraftAccount.findUnique({
    where: { userId_minecraftAccountId: { userId: session.user.id, minecraftAccountId: id } },
  });
  return !!assignment;
}

export async function createAccount(input: CreateAccountInput, creator: SessionContext) {
  const name = input.name.trim();
  const account = await prisma.minecraftAccount.create({
    // Every account authenticates through the Microsoft device-code flow; no
    // password is stored (credentialsPassword stays null — the bot falls
    // straight through to device-code when it's absent).
    data: { ...input, name, authType: "MICROSOFT", credentialsPassword: null, createdById: creator.user.id },
    select: publicAccountSelect,
  });

  // Non-admin creators automatically get access to their own account (admins
  // already see/manage every account regardless of assignment, so no row is
  // needed for them). Admins can grant additional users access afterwards.
  if (creator.user.role !== "ADMIN") {
    await setAssignments(account.id, [creator.user.id]);
    return (await getAccountForSession(creator, account.id))!;
  }
  return present(account);
}

export async function updateAccount(id: string, input: UpdateAccountInput) {
  const account = await prisma.minecraftAccount.update({ where: { id }, data: input, select: publicAccountSelect });
  return present(account);
}

export async function deleteAccount(id: string) {
  await prisma.minecraftAccount.delete({ where: { id } });
}

export async function setAssignments(accountId: string, userIds: string[]) {
  const uniqueUserIds = Array.from(new Set(userIds));
  await prisma.$transaction([
    prisma.userMinecraftAccount.deleteMany({ where: { minecraftAccountId: accountId } }),
    prisma.userMinecraftAccount.createMany({
      data: uniqueUserIds.map((userId) => ({ userId, minecraftAccountId: accountId })),
    }),
  ]);
}

/** Internal helper for ClientManager/commands module: includes the credentials field. */
export async function getFullAccount(id: string) {
  return prisma.minecraftAccount.findUnique({ where: { id } });
}

/**
 * Rolling auto-sell earnings for an account over the last 5 minutes, hour and
 * 24 hours. Prunes rows older than 24h first so the table can't grow unbounded.
 */
export async function getEarningsSummary(id: string) {
  const now = Date.now();
  const cutoff24h = new Date(now - 24 * 60 * 60_000);
  await prisma.sellEarning.deleteMany({
    where: { minecraftAccountId: id, createdAt: { lt: cutoff24h } },
  });

  const rows = await prisma.sellEarning.findMany({
    where: { minecraftAccountId: id, createdAt: { gte: cutoff24h } },
    select: { amount: true, createdAt: true },
  });

  const since5m = now - 5 * 60_000;
  const since1h = now - 60 * 60_000;
  let last5m = 0;
  let last1h = 0;
  let last24h = 0;
  for (const row of rows) {
    const t = row.createdAt.getTime();
    last24h += row.amount;
    if (t >= since1h) last1h += row.amount;
    if (t >= since5m) last5m += row.amount;
  }
  return { last5m, last1h, last24h };
}
