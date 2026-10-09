import type { FastifyInstance } from "fastify";
import { canAccessAccount } from "../accounts/service.js";
import { clientManager } from "../minecraft/ClientManager.js";
import { getConsoleLogs } from "../logging/consoleLogService.js";
import { executeCommand } from "../commands/service.js";
import { sniperManager } from "../namesniper/SniperManager.js";
import { getSniperLogs } from "../logging/sniperLogService.js";
import { onAccountImageUpdated } from "../accounts/images.js";
import { commandSchema } from "../accounts/schemas.js";
import { recordAuditLog } from "../logging/auditLog.js";
import { authorizeSocket } from "./authorization.js";

/** Cookie-authenticated website sockets require a trusted Origin (app.ts). */
export default async function registerWebsocketRoutes(app: FastifyInstance) {
  app.get("/ws/accounts/:id", { websocket: true }, (socket, req) => {
    const { id: accountId } = req.params as { id: string };
    const connection = authorizeSocket(socket, req, { accountId });
    if (!connection) return;
    const { run, send, subscribe } = connection;
    run(async () => {
      const history = await getConsoleLogs(accountId);
      send({ type: "history", logs: history });
      const status = clientManager.get(accountId)?.getStatus();
      if (status) send({ type: "status", status });
    });
    subscribe(clientManager.onConsoleEvent((event) => {
      if (event.minecraftAccountId === accountId) run(() => send({ type: "console", event }));
    }));
    subscribe(clientManager.onStatusEvent((status) => {
      if (status.id === accountId) run(() => send({ type: "status", status }));
    }));
    let messages = 0, windowStart = Date.now();
    socket.on("message", (raw, binary) => {
      if (Date.now() - windowStart > 10_000) { messages = 0; windowStart = Date.now(); }
      if (++messages > 20) { socket.close(4429, "Command rate limit"); return; }
      if (binary || Buffer.byteLength(raw as Buffer) > 4096) { socket.close(4400, "Invalid message"); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString()); } catch { send({ type: "error", reason: "INVALID_MESSAGE" }); return; }
      run(async (session) => {
        const message = parsed as { type?: unknown; command?: unknown; csrfToken?: unknown } | null;
        const body = commandSchema.safeParse(message);
        if (message?.type !== "command" || !body.success) { send({ type: "error", reason: "INVALID_MESSAGE" }); return; }
        if (message.csrfToken !== session.csrfToken) { send({ type: "error", reason: "INVALID_CSRF" }); return; }
        const result = await executeCommand(session, accountId, body.data.command);
        if (!result.ok) send({ type: "error", reason: result.reason });
        else await recordAuditLog({ userId: session.user.id, action: "ACCOUNT_COMMAND", targetType: "MinecraftAccount", targetId: accountId,
          details: { command: body.data.command } });
      });
    });
  });

  app.get("/ws/dashboard", { websocket: true }, (socket, req) => {
    const connection = authorizeSocket(socket, req);
    if (!connection) return;
    const { run, send, subscribe } = connection;
    run(async (session) => {
      const statuses = clientManager.getAllStatuses();
      const allowed = await Promise.all(statuses.map((status) => canAccessAccount(session, status.id)));
      send({ type: "statuses", statuses: statuses.filter((_, index) => allowed[index]) });
    });
    subscribe(clientManager.onStatusEvent((status) => {
      run(async (session) => { if (await canAccessAccount(session, status.id)) send({ type: "status", status }); });
    }));
    subscribe(onAccountImageUpdated((update) => {
      run(async (session) => { if (await canAccessAccount(session, update.id)) send({ type: "account_image", ...update }); });
    }));
    subscribe(clientManager.onSellEvent((update) => {
      run(async (session) => { if (await canAccessAccount(session, update.id)) send({ type: "account_sale", ...update }); });
    }));
  });

  app.get("/ws/namesniper/:id", { websocket: true }, (socket, req) => {
    const { id: accountId } = req.params as { id: string };
    const connection = authorizeSocket(socket, req, { adminOnly: true });
    if (!connection) return;
    const { run, send, subscribe } = connection;
    run(async () => {
      send({ type: "history", logs: await getSniperLogs(accountId, 200) });
      const status = sniperManager.get(accountId)?.getStatus();
      if (status) send({ type: "status", status });
    });
    subscribe(sniperManager.onConsoleEvent((event) => {
      if (event.sniperAccountId === accountId) run(() => send({ type: "console", event }));
    }));
    subscribe(sniperManager.onStatusEvent((status) => {
      if (status.id === accountId) run(() => send({ type: "status", status }));
    }));
  });

  app.get("/ws/namesniper-dashboard", { websocket: true }, (socket, req) => {
    const connection = authorizeSocket(socket, req, { adminOnly: true });
    if (!connection) return;
    const { run, send, subscribe } = connection;
    run(() => send({ type: "statuses", statuses: sniperManager.getAllStatuses() }));
    subscribe(sniperManager.onStatusEvent((status) => run(() => send({ type: "status", status }))));
  });
}
