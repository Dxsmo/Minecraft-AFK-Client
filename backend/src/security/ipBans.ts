import { prisma } from "../database/prisma.js";
import { logger } from "../logging/logger.js";

/**
 * In-memory cache of banned IPs plus an auto-ban tracker for repeated failed
 * logins. The cache is loaded once at startup and kept in sync on every
 * ban/unban, so the global request guard (see app.ts) does a synchronous
 * Set lookup on the hot path instead of a DB round-trip per request.
 */
const bannedIps = new Set<string>();

// Sliding-window failed-login counters keyed by IP.
const AUTO_BAN_THRESHOLD = 15;
const AUTO_BAN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const failedLogins = new Map<string, number[]>();

export async function loadBannedIps(): Promise<void> {
  const rows = await prisma.bannedIp.findMany({ select: { ip: true } });
  bannedIps.clear();
  for (const r of rows) bannedIps.add(r.ip);
  logger.info({ count: bannedIps.size }, "Loaded banned IPs");
}

export function isIpBanned(ip: string | undefined | null): boolean {
  return !!ip && bannedIps.has(ip);
}

export async function listBannedIps() {
  return prisma.bannedIp.findMany({
    orderBy: { createdAt: "desc" },
    include: { createdBy: { select: { id: true, username: true } } },
  });
}

export async function banIp(
  ip: string,
  opts: { reason?: string; auto?: boolean; createdById?: string } = {},
): Promise<void> {
  await prisma.bannedIp.upsert({
    where: { ip },
    create: { ip, reason: opts.reason ?? null, auto: opts.auto ?? false, createdById: opts.createdById ?? null },
    update: { reason: opts.reason ?? null, auto: opts.auto ?? false },
  });
  bannedIps.add(ip);
}

export async function unbanIp(ip: string): Promise<void> {
  await prisma.bannedIp.delete({ where: { ip } }).catch(() => undefined);
  bannedIps.delete(ip);
  failedLogins.delete(ip);
}

/**
 * Records a failed login from `ip` and auto-bans it once too many failures
 * happen inside the sliding window. Complements the per-route rate limit:
 * rate limiting throttles bursts, this permanently blocks persistent abusers.
 * Returns true if this call triggered an auto-ban.
 */
export async function registerFailedLogin(ip: string | undefined | null): Promise<boolean> {
  if (!ip) return false;
  const now = Date.now();
  const hits = (failedLogins.get(ip) ?? []).filter((t) => now - t < AUTO_BAN_WINDOW_MS);
  hits.push(now);
  failedLogins.set(ip, hits);
  if (hits.length >= AUTO_BAN_THRESHOLD && !bannedIps.has(ip)) {
    await banIp(ip, { auto: true, reason: `Auto-banned after ${hits.length} failed logins` });
    failedLogins.delete(ip);
    logger.warn({ ip }, "Auto-banned IP after repeated failed logins");
    return true;
  }
  return false;
}

/** Clears the failed-login counter for an IP after a successful login. */
export function clearFailedLogins(ip: string | undefined | null): void {
  if (ip) failedLogins.delete(ip);
}
