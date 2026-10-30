import type { FastifyInstance } from "fastify";
import { clientManager } from "../minecraft/ClientManager.js";
import { getConsoleLogs } from "../logging/consoleLogService.js";
import { executeCommand } from "../commands/service.js";
import { onAccountImageUpdated } from "../accounts/images.js";
import { commandSchema } from "../accounts/schemas.js";
import { recordAuditLog } from "../logging/auditLog.js";
import { authorizeSocket } from "./authorization.js";
import { prisma } from "../database/prisma.js";
import type { SessionContext } from "../auth/session.js";
import type { ClientStatusSnapshot } from "../minecraft/types.js";
import { RemoteControlSession, remoteInputSchema } from "../soulfire/remoteControl.js";
import { LiveCamStreams } from "../soulfire/liveCam.js";

function batchLiveEvents(socket: import("ws").WebSocket, connection: NonNullable<ReturnType<typeof authorizeSocket>>) {
  let messages: unknown[] = [];
  const latest = new Map<string, unknown>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  connection.subscribe(() => clearTimeout(timer));
  return (message: unknown, key?: string) => {
    if (socket.readyState !== socket.OPEN) return;
    if (key) latest.set(key, message);
    else messages.push(message);
    if (messages.length > 2000) { socket.close(4429, "Slow consumer"); return; }
    timer ??= setTimeout(() => {
      timer = undefined;
      const batch = [...messages, ...latest.values()];
      messages = []; latest.clear();
      // Recheck permissions for the batch, rather than querying SQLite for
      // every chat line. Commands still get their own authorization check.
      connection.run(() => { for (const entry of batch) connection.send(entry); });
    }, 25);
  };
}

/** Cookie-authenticated website sockets require a trusted Origin (app.ts). */
export default async function registerWebsocketRoutes(app: FastifyInstance) {
  const cameras = new LiveCamStreams();
  app.addHook("onClose", () => cameras.close());

  app.get("/ws/accounts/:id/control", { websocket: true }, (socket, req) => {
    const { id: accountId } = req.params as { id: string };
    const connection = authorizeSocket(socket, req, { accountId });
    if (!connection) return;
    const { run, send, subscribe } = connection;
    run(() => {}); // Reject an unassigned account before any input arrives.
    let remote: RemoteControlSession | undefined;
    let controllerUserId: string | undefined;
    let count = 0, windowStart = Date.now();
    subscribe(() => {
      void (async () => {
        await remote?.stop();
        if (controllerUserId) await recordAuditLog({ userId: controllerUserId, action: "ACCOUNT_REMOTE_STOP", targetType: "MinecraftAccount", targetId: accountId });
      })().catch(error => req.log.warn({ err: error, accountId }, "Remote cleanup failed"));
    });
    socket.on("message", (raw, binary) => {
      if (Date.now() - windowStart >= 1000) { count = 0; windowStart = Date.now(); }
      if (binary || Buffer.byteLength(raw as Buffer) > 32768 || ++count > 80) { socket.close(4429, "Input limit"); return; }
      let body: any;
      try { body = JSON.parse(raw.toString()); } catch { socket.close(4400, "Invalid input"); return; }
      run(async session => {
        if (body?.type === "stop") { await remote?.stop(); socket.close(1000, "Control released"); return; }
        if (body?.type === "start" && !remote) {
          if (body.csrfToken !== session.csrfToken) { socket.close(4403, "Invalid CSRF"); return; }
          if (clientManager.get(accountId)?.getStatus().status !== "ONLINE") { socket.close(4409, "Account offline"); return; }
          controllerUserId = session.user.id;
          await recordAuditLog({ userId: controllerUserId, action: "ACCOUNT_REMOTE_START", targetType: "MinecraftAccount", targetId: accountId });
          if (socket.readyState !== socket.OPEN) return;
          remote = new RemoteControlSession(accountId, message => {
            if (socket.readyState !== socket.OPEN || socket.bufferedAmount > 512 * 1024) return false;
            send(message); return true;
          }, message => { send({ type: "error", message }); socket.close(1011, "Control unavailable"); });
          try { await remote.start(); }
          catch (error) { send({ type: "error", message: error instanceof Error ? error.message : "Fernsteuerung nicht verfügbar." }); socket.close(1011); }
          return;
        }
        const input = remoteInputSchema.safeParse(body);
        if (!remote || !input.success) { socket.close(4400, "Invalid input"); return; }
        remote.input(input.data);
      });
    });
    subscribe(clientManager.onStatusEvent(status => {
      if (status.id === accountId && status.status !== "ONLINE") socket.close(1000, "Account offline");
    }));
  });

  app.get("/ws/accounts/:id/camera", { websocket: true }, (socket, req) => {
    const { id: accountId } = req.params as { id: string };
    const connection = authorizeSocket(socket, req, { accountId });
    if (!connection) return;
    const { run, send, subscribe } = connection;
    // Complete the current account permission check before touching SoulFire.
    run(() => {
      if (socket.readyState !== socket.OPEN) return;
      if (clientManager.get(accountId)?.getStatus().status !== "ONLINE") {
        send({ type: "offline" }); socket.close(1000, "Account offline"); return;
      }
      send({ type: "loading" });
      // Drop frames for slow clients instead of queuing renders or image data.
      let pending = false;
      subscribe(cameras.subscribe(accountId, {
        loading: () => run(() => send({ type: "loading" })),
        frame: frame => {
          if (pending || socket.readyState !== socket.OPEN || socket.bufferedAmount > 512 * 1024) return;
          pending = true;
          run(() => { try { send(frame); } finally { pending = false; } });
        },
        error: error => {
          req.log.warn({ err: error, accountId }, "Live cam stream stopped");
          run(() => { send({ type: "error", message: "Die Live Cam konnte nicht geladen werden. Bitte erneut versuchen." }); socket.close(1011, "Camera unavailable"); });
        },
      }));
      subscribe(clientManager.onStatusEvent(status => {
        if (status.id === accountId && status.status !== "ONLINE") {
          send({ type: "offline" }); socket.close(1000, "Account offline");
        }
      }));
    });
  });

  app.get("/ws/accounts/:id", { websocket: true }, (socket, req) => {
    const { id: accountId } = req.params as { id: string };
    const connection = authorizeSocket(socket, req, { accountId });
    if (!connection) return;
    const { run, send, subscribe } = connection;
    const publish = batchLiveEvents(socket, connection);
    run(async () => {
      const history = await getConsoleLogs(accountId);
      send({ type: "history", logs: history });
      const status = clientManager.get(accountId)?.getStatus();
      if (status) send({ type: "status", status });
    });
    subscribe(clientManager.onConsoleEvent((event) => {
      if (event.minecraftAccountId === accountId) publish({ type: "console", event });
    }));
    subscribe(clientManager.onStatusEvent((status) => {
      if (status.id === accountId) publish({ type: "status", status }, "status");
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
    async function allowedAccountIds(session: SessionContext) {
      if (session.user.role === "ADMIN") return null;
      const assignments = await prisma.userMinecraftAccount.findMany({
        where: { userId: session.user.id }, select: { minecraftAccountId: true },
      });
      return new Set(assignments.map(a => a.minecraftAccountId));
    }
    run(async (session) => {
      const statuses = clientManager.getAllStatuses();
      const allowed = await allowedAccountIds(session);
      send({ type: "statuses", statuses: allowed ? statuses.filter(status => allowed.has(status.id)) : statuses });
    });
    // Coalesce short bursts from many bots. Each batch checks the current
    // session and assignments once, without caching authorization decisions.
    const statuses = new Map<string, ClientStatusSnapshot>();
    const images = new Map<string, { id: string; imageUrl: string }>();
    const sales = new Map<string, { id: string; lastSellAt: string }>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    function scheduleFlush() {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        const batch = [
          ...Array.from(statuses.values(), status => ({ id: status.id, message: { type: "status", status } })),
          ...Array.from(images.values(), update => ({ id: update.id, message: { type: "account_image", ...update } })),
          ...Array.from(sales.values(), update => ({ id: update.id, message: { type: "account_sale", ...update } })),
        ];
        statuses.clear(); images.clear(); sales.clear();
        run(async session => {
          const allowed = await allowedAccountIds(session);
          for (const entry of batch) if (!allowed || allowed.has(entry.id)) send(entry.message);
        });
      }, 25);
    }
    subscribe(() => clearTimeout(flushTimer));
    subscribe(clientManager.onStatusEvent((status) => {
      statuses.set(status.id, status); scheduleFlush();
    }));
    subscribe(onAccountImageUpdated((update) => {
      images.set(update.id, update); scheduleFlush();
    }));
    subscribe(clientManager.onSellEvent((update) => {
      sales.set(update.id, update); scheduleFlush();
    }));
  });

}
