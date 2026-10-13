import { prisma } from "../database/prisma.js";
import type { Prisma } from "@prisma/client";
import type { SessionContext } from "../auth/session.js";
import { preferencesSchema, type DashboardPreferences, type PreferencesPatch } from "./schemas.js";

function decode(raw: string | null): DashboardPreferences {
  try {
    const result = preferencesSchema.safeParse(JSON.parse(raw ?? "{}"));
    if (result.success) return result.data;
  } catch { /* Recover safely from malformed legacy data. */ }
  return preferencesSchema.parse({});
}

export function applyAccountOrder<T extends { id: string }>(accounts: T[], order: string[]): T[] {
  const ranks = new Map(order.map((id, index) => [id, index]));
  // Stable sorting preserves the legacy order for accounts without a preference.
  return accounts.sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
}

export async function getAccountOrder(userId: string): Promise<string[]> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { dashboardPreferences: true } });
  return decode(user.dashboardPreferences).accountOrder;
}

async function scope(db: Prisma.TransactionClient, session: SessionContext) {
  const accounts = await db.minecraftAccount.findMany({
    where: session.user.role === "ADMIN" ? {} : { assignments: { some: { userId: session.user.id } } }, select: { id: true },
  });
  const uploaders = session.user.role === "ADMIN" ? await db.user.findMany({ select: { id: true } }) : [];
  return { accounts: new Set(accounts.map(account => account.id)),
    uploaders: new Set(session.user.role === "ADMIN" ? ["unassigned", ...uploaders.map(user => `user:${user.id}`)] : []) };
}

function visible(preferences: DashboardPreferences, allowed: Awaited<ReturnType<typeof scope>>) {
  return {
    accountOrder: preferences.accountOrder.filter(id => allowed.accounts.has(id)),
    blurredAccountIds: preferences.blurredAccountIds.filter(id => allowed.accounts.has(id)),
    uploaderOrder: preferences.uploaderOrder.filter(id => allowed.uploaders.has(id)),
    collapsedUploaderIds: preferences.collapsedUploaderIds.filter(id => allowed.uploaders.has(id)),
  };
}

export async function getPreferences(session: SessionContext) {
  const [user, allowed] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: session.user.id }, select: { dashboardPreferences: true } }),
    scope(prisma, session),
  ]);
  return { initialized: user.dashboardPreferences !== null, preferences: visible(decode(user.dashboardPreferences), allowed) };
}

function invalid(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}

function setMembership(ids: string[], id: string, value: boolean) {
  return value ? [...new Set([...ids, id])] : ids.filter(item => item !== id);
}

export async function updatePreferences(session: SessionContext, patch: PreferencesPatch) {
  return prisma.$transaction(async db => {
    const user = await db.user.findUniqueOrThrow({ where: { id: session.user.id }, select: { dashboardPreferences: true } });
    const allowed = await scope(db, session);
    const preferences = decode(user.dashboardPreferences);
    if (patch.accountOrder !== undefined) {
      if (patch.accountOrder.length !== allowed.accounts.size || patch.accountOrder.some(id => !allowed.accounts.has(id))) {
        invalid("Invalid account order payload");
      }
      // Keep inaccessible account positions privately so restored assignments
      // can recover their preferences; never return those IDs to the caller.
      preferences.accountOrder = [...patch.accountOrder, ...preferences.accountOrder.filter(id => !allowed.accounts.has(id))];
    }
    if (patch.blur) {
      if (!allowed.accounts.has(patch.blur.accountId)) invalid("Account not found", 404);
      preferences.blurredAccountIds = setMembership(preferences.blurredAccountIds, patch.blur.accountId, patch.blur.value);
    }
    if (patch.uploaderOrder !== undefined || patch.collapse) {
      if (session.user.role !== "ADMIN") invalid("Admin role required", 403);
      if (patch.uploaderOrder !== undefined) {
        if (patch.uploaderOrder.some(id => !allowed.uploaders.has(id))) invalid("Invalid uploader order payload");
        preferences.uploaderOrder = patch.uploaderOrder;
      }
      if (patch.collapse) {
        if (!allowed.uploaders.has(patch.collapse.uploaderId)) invalid("Uploader not found", 404);
        preferences.collapsedUploaderIds = setMembership(preferences.collapsedUploaderIds, patch.collapse.uploaderId, patch.collapse.value);
      }
    }
    await db.user.update({ where: { id: session.user.id }, data: { dashboardPreferences: JSON.stringify(preferences) } });
    return { initialized: true, preferences: visible(preferences, allowed) };
  });
}

/** A one-time, conditional import cannot overwrite an existing server profile. */
export async function importPreferences(session: SessionContext, legacy: DashboardPreferences) {
  return prisma.$transaction(async db => {
    const allowed = await scope(db, session);
    await db.user.updateMany({ where: { id: session.user.id, dashboardPreferences: null },
      data: { dashboardPreferences: JSON.stringify(visible(legacy, allowed)) } });
    const user = await db.user.findUniqueOrThrow({ where: { id: session.user.id }, select: { dashboardPreferences: true } });
    return { initialized: true, preferences: visible(decode(user.dashboardPreferences), allowed) };
  });
}
