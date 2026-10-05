import { prisma } from "../database/prisma.js";
import type { CreateAccountInput, UpdateAccountInput } from "./schemas.js";
import type { SessionContext } from "../auth/session.js";
import { parseSpawnerActions } from "../minecraft/spawners.js";

/** Parses the JSON-encoded daily spawner-clear times into a string array. */
export function parseDailyTimes(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Decode the remaining JSON settings for API clients. */
function present<T extends { spawnerActions: string; spawnerClearTimes: string }>(account: T) {
  const { spawnerActions, spawnerClearTimes, ...rest } = account;
  return { ...rest, spawnerActions: parseSpawnerActions(spawnerActions), spawnerClearTimes: parseDailyTimes(spawnerClearTimes) };
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
  crouchEnabled: true,
  autoReconnect: true,
  notes: true,
  autoSellEnabled: true,
  autoSellIntervalSeconds: true,
  autoSellCommand: true,
  spawnerType: true,
  spawnerActions: true,
  spawnerClearEnabled: true,
  spawnerClearTimes: true,
  status: true,
  dashboardOrder: true,
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
      ? await prisma.minecraftAccount.findMany({ select: publicAccountSelect, orderBy: [{ dashboardOrder: "asc" }, { name: "asc" }] })
      : await prisma.minecraftAccount.findMany({
          where: { assignments: { some: { userId: session.user.id } } },
          select: publicAccountSelect,
          orderBy: [{ dashboardOrder: "asc" }, { name: "asc" }],
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

/**
 * Returns true if the session's user may grant/revoke *other* users' access to
 * this account. Allowed for admins (who can manage every account) and for the
 * account's own creator/operator. Admins always retain access regardless of the
 * assignment rows, so ticking an admin in the picker is purely cosmetic.
 */
export async function canManageAssignments(session: SessionContext, id: string): Promise<boolean> {
  if (session.user.role === "ADMIN") return true;
  const account = await prisma.minecraftAccount.findUnique({
    where: { id },
    select: { createdById: true },
  });
  return !!account && account.createdById === session.user.id;
}

/** Minimal user list (id, username, role) for the account access picker. */
export async function listAssignableUsers() {
  return prisma.user.findMany({
    select: { id: true, username: true, role: true },
    orderBy: { username: "asc" },
  });
}

export async function createAccount(input: CreateAccountInput, creator: SessionContext) {
  const name = input.name.trim();
  const maxOrder = await prisma.minecraftAccount.aggregate({ _max: { dashboardOrder: true } });
  const account = await prisma.minecraftAccount.create({
    // Every account authenticates through the Microsoft device-code flow; no
    // password is stored (credentialsPassword stays null — the bot falls
    // straight through to device-code when it's absent).
    data: {
      ...input,
      name,
      authType: "MICROSOFT",
      credentialsPassword: null,
      createdById: creator.user.id,
      dashboardOrder: (maxOrder._max.dashboardOrder ?? -1) + 1,
    },
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

/**
 * One-time-per-boot cleanup: remove any Minecraft passwords still stored on
 * legacy accounts. All accounts are kept intact — only the `credentialsPassword`
 * column is cleared, since sign-in now happens exclusively through the
 * interactive Microsoft device-code flow and the on-disk refresh token cache.
 * Idempotent: does nothing once no passwords remain.
 */
export async function purgeStoredPasswords(): Promise<number> {
  const res = await prisma.minecraftAccount.updateMany({
    where: { credentialsPassword: { not: null } },
    data: { credentialsPassword: null },
  });
  return res.count;
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

/** Persist a full dashboard order for all accounts visible to the session user. */
export async function reorderAccountsForSession(session: SessionContext, accountIds: string[]): Promise<boolean> {
  const visible =
    session.user.role === "ADMIN"
      ? await prisma.minecraftAccount.findMany({ select: { id: true } })
      : await prisma.minecraftAccount.findMany({
          where: { assignments: { some: { userId: session.user.id } } },
          select: { id: true },
        });
  const visibleIds = visible.map((a) => a.id);
  if (visibleIds.length !== accountIds.length) return false;
  const wanted = new Set(accountIds);
  if (wanted.size !== visibleIds.length) return false;
  for (const id of visibleIds) if (!wanted.has(id)) return false;

  await prisma.$transaction(
    accountIds.map((id, idx) =>
      prisma.minecraftAccount.update({
        where: { id },
        data: { dashboardOrder: idx },
      }),
    ),
  );
  return true;
}

/** Internal helper for ClientManager/commands module: includes the credentials field. */
export async function getFullAccount(id: string) {
  return prisma.minecraftAccount.findUnique({ where: { id } });
}

/** Remove expired earnings independently of whether an account page is open. */
export async function pruneOldEarnings(now = Date.now()) {
  return prisma.sellEarning.deleteMany({ where: { createdAt: { lt: new Date(now - 24 * 60 * 60_000) } } });
}

/** Aggregate in SQLite: return three numbers rather than every sale in 24h. */
export async function getEarningsSummary(id: string) {
  const now = Date.now();
  const rows = await prisma.$queryRaw<Array<{ last5m: number | bigint; last1h: number | bigint; last24h: number | bigint }>>`
    SELECT
      COALESCE(SUM(CASE WHEN "createdAt" >= ${new Date(now - 5 * 60_000)} THEN ROUND("amount" * 100) ELSE 0 END), 0) AS "last5m",
      COALESCE(SUM(CASE WHEN "createdAt" >= ${new Date(now - 60 * 60_000)} THEN ROUND("amount" * 100) ELSE 0 END), 0) AS "last1h",
      COALESCE(SUM(ROUND("amount" * 100)), 0) AS "last24h"
    FROM "SellEarning"
    WHERE "minecraftAccountId" = ${id}
      AND "createdAt" >= ${new Date(now - 24 * 60 * 60_000)} AND "createdAt" <= ${new Date(now)}
  `;
  const totals = rows[0];
  return { last5m: Number(totals.last5m) / 100, last1h: Number(totals.last1h) / 100, last24h: Number(totals.last24h) / 100 };
}
