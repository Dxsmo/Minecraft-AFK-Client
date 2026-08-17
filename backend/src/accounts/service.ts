import { prisma } from "../database/prisma.js";
import type { CreateAccountInput, UpdateAccountInput } from "./schemas.js";
import type { SessionContext } from "../auth/session.js";

/**
 * Fields safe to expose to any authorized viewer. `credentialsSecret` is
 * intentionally excluded so Minecraft credentials never reach the frontend,
 * satisfying the "no sensitive Minecraft credentials to the client" requirement.
 */
const publicAccountSelect = {
  id: true,
  name: true,
  minecraftVersion: true,
  serverHost: true,
  serverPort: true,
  authType: true,
  afkEnabled: true,
  movementEnabled: true,
  afkIntervalSeconds: true,
  autoReconnect: true,
  autoCommandEnabled: true,
  autoCommandText: true,
  autoCommandIntervalMinutes: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  assignments: {
    select: { userId: true, user: { select: { id: true, username: true } } },
  },
} as const;

export async function listAccountsForSession(session: SessionContext) {
  if (session.user.role === "ADMIN") {
    return prisma.minecraftAccount.findMany({ select: publicAccountSelect, orderBy: { name: "asc" } });
  }
  return prisma.minecraftAccount.findMany({
    where: { assignments: { some: { userId: session.user.id } } },
    select: publicAccountSelect,
    orderBy: { name: "asc" },
  });
}

export async function getAccountForSession(session: SessionContext, id: string) {
  const account = await prisma.minecraftAccount.findUnique({ where: { id }, select: publicAccountSelect });
  if (!account) return null;
  if (session.user.role !== "ADMIN" && !account.assignments.some((a) => a.userId === session.user.id)) {
    return null;
  }
  return account;
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
  const name = input.name?.trim() || (await deriveAccountName(input));
  const account = await prisma.minecraftAccount.create({
    data: { ...input, name },
    select: publicAccountSelect,
  });

  // Non-admin creators automatically get access to their own account (admins
  // already see/manage every account regardless of assignment, so no row is
  // needed for them). Admins can grant additional users access afterwards.
  if (creator.user.role !== "ADMIN") {
    await setAssignments(account.id, [creator.user.id]);
    return (await getAccountForSession(creator, account.id))!;
  }
  return account;
}

/**
 * Derives a valid, unique temporary display name when none was provided. Used
 * for Microsoft accounts, where the real in-game username isn't known until the
 * bot signs in — at which point it's auto-renamed (see ClientManager).
 */
async function deriveAccountName(input: CreateAccountInput): Promise<string> {
  let base = "bot";
  if (input.authType === "MICROSOFT" && input.credentialsSecret) {
    base = input.credentialsSecret.split("@")[0] || "bot";
  }
  base = base.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
  if (base.length < 2) base = `bot-${base}`.slice(0, 24);

  let candidate = base;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await prisma.minecraftAccount.findUnique({ where: { name: candidate }, select: { id: true } })) {
    const suffix = `-${n++}`;
    candidate = base.slice(0, 32 - suffix.length) + suffix;
  }
  return candidate;
}

export async function updateAccount(id: string, input: UpdateAccountInput) {
  return prisma.minecraftAccount.update({ where: { id }, data: input, select: publicAccountSelect });
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
