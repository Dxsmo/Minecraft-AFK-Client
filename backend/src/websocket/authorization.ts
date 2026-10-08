import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { getSession, onSessionsRevoked, type SessionContext } from "../auth/session.js";
import { canAccessAccount } from "../accounts/service.js";
import { logger } from "../logging/logger.js";

/** Every queued action rechecks the session and current permissions before sending data. */
export function authorizeSocket(socket: WebSocket, req: FastifyRequest, access: { accountId?: string; adminOnly?: boolean } = {}) {
  const initial = req.session;
  if (!initial) { socket.close(4401, "Unauthorized"); return null; }
  const sessionId = initial.sessionId, userId = initial.user.id;
  let jobs = Promise.resolve();
  let pending = 0;
  const cleanup: (() => void)[] = [];
  let disposed = false;
  function subscribe(unsubscribe: () => void) {
    if (disposed) unsubscribe();
    else cleanup.push(unsubscribe);
  }
  function run(action: (session: SessionContext) => void | Promise<void>) {
    if (socket.readyState !== socket.OPEN) return;
    if (pending >= 64) { socket.close(4429, "Slow consumer"); return; }
    pending++;
    jobs = jobs.then(async () => {
      if (socket.readyState !== socket.OPEN) return;
      const session = await getSession(sessionId);
      if (!session || (access.adminOnly && session.user.role !== "ADMIN") ||
          (access.accountId && !await canAccessAccount(session, access.accountId))) {
        socket.close(4401, "Authorization expired");
        return;
      }
      if (socket.readyState === socket.OPEN) await action(session);
    }).catch((err) => {
      logger.error({ err }, "WebSocket authorization failed");
      socket.close(1011, "Authorization failed");
    }).finally(() => { pending--; });
  }
  function send(data: unknown) {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(4429, "Slow consumer"); return; }
    socket.send(JSON.stringify(data));
  }
  subscribe(onSessionsRevoked((revocation) => {
    if ((!revocation.sessionId && !revocation.userId) || revocation.sessionId === sessionId || revocation.userId === userId) {
      socket.close(4401, "Session revoked");
    }
  }));
  const timer = setInterval(() => run(() => {}), 15_000);
  timer.unref();
  subscribe(() => clearInterval(timer));
  socket.on("close", () => {
    disposed = true;
    for (const unsubscribe of cleanup.splice(0)) unsubscribe();
  });
  socket.on("error", () => socket.close());
  return { run, send, subscribe };
}
