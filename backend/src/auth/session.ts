import { nanoid } from "nanoid";
import { prisma } from "../database/prisma.js";
import { config } from "../config/config.js";
import type { Role, User } from "@prisma/client";

export interface SessionContext {
  sessionId: string;
  csrfToken: string;
  user: Pick<User, "id" | "username" | "role" | "status">;
}

/**
 * Server-side session store backed by SQLite via Prisma. Chosen over JWT so
 * sessions can be revoked instantly (logout, disabled user, admin action)
 * without needing a token blocklist.
 */
export async function createSession(
  userId: string,
  meta: { userAgent?: string; ipAddress?: string },
): Promise<{ sessionId: string; csrfToken: string; expiresAt: Date }> {
  const sessionId = nanoid(48);
  const csrfToken = nanoid(32);
  const expiresAt = new Date(Date.now() + config.session.ttlHours * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      id: sessionId,
      userId,
      csrfToken,
      expiresAt,
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
    },
  });

  return { sessionId, csrfToken, expiresAt };
}

export async function getSession(sessionId: string): Promise<SessionContext | null> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });

  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
    return null;
  }
  if (session.user.status === "DISABLED") return null;

  return {
    sessionId: session.id,
    csrfToken: session.csrfToken,
    user: {
      id: session.user.id,
      username: session.user.username,
      role: session.user.role as Role,
      status: session.user.status,
    },
  };
}

export async function destroySession(sessionId: string): Promise<void> {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
}

export async function destroyAllUserSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

/**
 * Wipes every session on the server. Called once at process startup so a
 * backend restart always forces everyone to log in again (in addition to
 * the login/change-password cookies being non-persistent browser-session
 * cookies, which handle the "closing the browser" case).
 */
export async function clearAllSessions(): Promise<void> {
  await prisma.session.deleteMany({});
}

/** Periodically clears expired sessions to keep the table small on the Pi. */
export async function pruneExpiredSessions(): Promise<void> {
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}
