import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { config } from "../config/config.js";
import { getSession } from "../auth/session.js";
import { canAccessAccount } from "../accounts/service.js";
import { clientManager } from "../minecraft/ClientManager.js";
import { getConsoleLogs } from "../logging/consoleLogService.js";
import { executeCommand } from "../commands/service.js";
import { sniperManager } from "../namesniper/SniperManager.js";
import { getSniperLogs } from "../logging/sniperLogService.js";
import { logger } from "../logging/logger.js";

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function safeSend(socket: WebSocket, data: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(data));
  } catch (err) {
    logger.error({ err }, "Failed to send WebSocket message");
  }
}

/**
 * Registers WebSocket routes for real-time updates:
 *  - /ws/accounts/:id  -> live console (chat/commands/system events) for one account
 *  - /ws/dashboard     -> live status snapshots for all accounts the user can see
 *
 * Auth is enforced manually here (rather than via the normal preHandler hook)
 * because the WebSocket upgrade request must be validated before accepting
 * the connection, using the same session cookie as regular HTTP requests.
 */
export default async function registerWebsocketRoutes(app: FastifyInstance) {
  app.get("/ws/accounts/:id", { websocket: true }, async (socket, req) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[config.session.cookieName];
    const session = sessionId ? await getSession(sessionId) : null;
    const { id: accountId } = req.params as { id: string };

    if (!session || !(await canAccessAccount(session, accountId))) {
      socket.close(4401, "Unauthorized");
      return;
    }

    const history = await getConsoleLogs(accountId, 200);
    safeSend(socket, { type: "history", logs: history });
    const status = clientManager.get(accountId)?.getStatus();
    if (status) safeSend(socket, { type: "status", status });

    const unsubscribeConsole = clientManager.onConsoleEvent((event) => {
      if (event.minecraftAccountId === accountId) safeSend(socket, { type: "console", event });
    });
    const unsubscribeStatus = clientManager.onStatusEvent((s) => {
      if (s.id === accountId) safeSend(socket, { type: "status", status: s });
    });

    socket.on("message", (raw: Buffer) => {
      void (async () => {
        try {
          const parsed = JSON.parse(raw.toString());
          if (parsed?.type === "command" && typeof parsed.command === "string") {
            const result = await executeCommand(session, accountId, parsed.command);
            if (!result.ok) safeSend(socket, { type: "error", reason: result.reason });
          }
        } catch (err) {
          safeSend(socket, { type: "error", reason: "INVALID_MESSAGE" });
          logger.debug({ err }, "Invalid websocket message received");
        }
      })();
    });

    socket.on("close", () => {
      unsubscribeConsole();
      unsubscribeStatus();
    });
  });

  app.get("/ws/dashboard", { websocket: true }, async (socket, req) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[config.session.cookieName];
    const session = sessionId ? await getSession(sessionId) : null;

    if (!session) {
      socket.close(4401, "Unauthorized");
      return;
    }

    const isAllowed = (accountId: string) =>
      session.user.role === "ADMIN" ? Promise.resolve(true) : canAccessAccount(session, accountId);

    safeSend(socket, { type: "statuses", statuses: clientManager.getAllStatuses() });

    const unsubscribeStatus = clientManager.onStatusEvent((s) => {
      void isAllowed(s.id).then((allowed) => {
        if (allowed) safeSend(socket, { type: "status", status: s });
      });
    });

    socket.on("close", () => {
      unsubscribeStatus();
    });
  });

  // ---- Name Sniper (admin-only) ----

  app.get("/ws/namesniper/:id", { websocket: true }, async (socket, req) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[config.session.cookieName];
    const session = sessionId ? await getSession(sessionId) : null;
    const { id: accountId } = req.params as { id: string };

    if (!session || session.user.role !== "ADMIN") {
      socket.close(4401, "Unauthorized");
      return;
    }

    const history = await getSniperLogs(accountId, 200);
    safeSend(socket, { type: "history", logs: history });
    const status = sniperManager.get(accountId)?.getStatus();
    if (status) safeSend(socket, { type: "status", status });

    const unsubscribeConsole = sniperManager.onConsoleEvent((event) => {
      if (event.sniperAccountId === accountId) safeSend(socket, { type: "console", event });
    });
    const unsubscribeStatus = sniperManager.onStatusEvent((s) => {
      if (s.id === accountId) safeSend(socket, { type: "status", status: s });
    });

    socket.on("close", () => {
      unsubscribeConsole();
      unsubscribeStatus();
    });
  });

  app.get("/ws/namesniper-dashboard", { websocket: true }, async (socket, req) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[config.session.cookieName];
    const session = sessionId ? await getSession(sessionId) : null;

    if (!session || session.user.role !== "ADMIN") {
      socket.close(4401, "Unauthorized");
      return;
    }

    safeSend(socket, { type: "statuses", statuses: sniperManager.getAllStatuses() });

    const unsubscribeStatus = sniperManager.onStatusEvent((s) => {
      safeSend(socket, { type: "status", status: s });
    });

    socket.on("close", () => {
      unsubscribeStatus();
    });
  });
}
