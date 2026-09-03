import { prisma } from "../database/prisma.js";
import type { CreateSniperAccountInput, UpdateSniperAccountInput } from "./schemas.js";
import type { SessionContext } from "../auth/session.js";
import { encryptSecret, decryptSecret } from "../utils/crypto.js";

/**
 * Fields safe to expose to the (admin-only) frontend. `email` is included —
 * unlike MinecraftAccount.credentialsSecret — because this whole feature is
 * already admin-only end to end and the admin explicitly entered it.
 */
const publicSniperSelect = {
  id: true,
  label: true,
  email: true,
  desiredName: true,
  cooldownSeconds: true,
  rateLimitProtection: true,
  proxies: true,
  enabled: true,
  status: true,
  currentName: true,
  lastAttemptAt: true,
  lastResult: true,
  lastSuccess: true,
  dashboardOrder: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, username: true } },
} as const;

/**
 * Decodes the at-rest-encrypted `proxies` column back to plaintext for the
 * admin frontend / runtime. Legacy plaintext rows are returned unchanged.
 */
function presentSniper<T extends { proxies: string }>(account: T): T {
  return { ...account, proxies: decryptSecret(account.proxies) };
}

export async function listSniperAccounts() {
  const rows = await prisma.sniperAccount.findMany({
    select: publicSniperSelect,
    orderBy: [{ dashboardOrder: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(presentSniper);
}

export async function getSniperAccount(id: string) {
  const row = await prisma.sniperAccount.findUnique({ where: { id }, select: publicSniperSelect });
  return row ? presentSniper(row) : null;
}

export async function createSniperAccount(input: CreateSniperAccountInput, creator: SessionContext) {
  const maxOrder = await prisma.sniperAccount.aggregate({ _max: { dashboardOrder: true } });
  const row = await prisma.sniperAccount.create({
    data: {
      label: input.label,
      email: input.email,
      createdById: creator.user.id,
      dashboardOrder: (maxOrder._max.dashboardOrder ?? -1) + 1,
    },
    select: publicSniperSelect,
  });
  return presentSniper(row);
}

export async function updateSniperAccount(id: string, input: UpdateSniperAccountInput) {
  // Encrypt proxy credentials at rest (they may embed user:pass@host).
  const data = input.proxies !== undefined ? { ...input, proxies: encryptSecret(input.proxies) } : input;
  const row = await prisma.sniperAccount.update({ where: { id }, data, select: publicSniperSelect });
  return presentSniper(row);
}

export async function deleteSniperAccount(id: string) {
  await prisma.sniperAccount.delete({ where: { id } });
}

/** Internal helper for SniperManager/routes: includes every column, with
 *  `proxies` decrypted so callers work with plaintext. */
export async function getFullSniperAccount(id: string) {
  const account = await prisma.sniperAccount.findUnique({ where: { id } });
  return account ? presentSniper(account) : null;
}

/** Persist a full dashboard order for every sniper account (admin-only feature, no per-user filtering needed). */
export async function reorderSniperAccounts(accountIds: string[]): Promise<boolean> {
  const visible = await prisma.sniperAccount.findMany({ select: { id: true } });
  const visibleIds = visible.map((a) => a.id);
  if (visibleIds.length !== accountIds.length) return false;
  const wanted = new Set(accountIds);
  if (wanted.size !== visibleIds.length) return false;
  for (const id of visibleIds) if (!wanted.has(id)) return false;

  await prisma.$transaction(
    accountIds.map((id, idx) =>
      prisma.sniperAccount.update({
        where: { id },
        data: { dashboardOrder: idx },
      }),
    ),
  );
  return true;
}
