import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createAccountSchema,
  updateAccountSchema,
  assignUsersSchema,
  commandSchema,
  moveItemSchema,
  dropItemSchema,
} from "./schemas.js";
import * as accountsService from "./service.js";
import { executeCommand } from "../commands/service.js";
import { clientManager } from "../minecraft/ClientManager.js";
import { getConsoleLogs } from "../logging/consoleLogService.js";
import { parseOrReject } from "../utils/validate.js";
import { recordAuditLog } from "../logging/auditLog.js";
import { prisma } from "../database/prisma.js";

export default async function accountsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);

  app.get("/api/minecraft/accounts", async (req, reply) => {
    const accounts = await accountsService.listAccountsForSession(req.session!);
    const statuses = new Map(clientManager.getAllStatuses().map((s) => [s.id, s]));
    reply.send(accounts.map((a) => ({ ...a, live: statuses.get(a.id) })));
  });

  app.get("/api/minecraft/accounts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const account = await accountsService.getAccountForSession(req.session!, id);
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    reply.send({ ...account, live: clientManager.get(id)?.getStatus() });
  });

  app.get("/api/minecraft/accounts/:id/logs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const account = await accountsService.getAccountForSession(req.session!, id);
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    const { limit } = req.query as { limit?: string };
    reply.send(await getConsoleLogs(id, limit ? Number(limit) : undefined));
  });

  app.get("/api/minecraft/accounts/:id/earnings", async (req, reply) => {
    const { id } = req.params as { id: string };
    const account = await accountsService.getAccountForSession(req.session!, id);
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    reply.send(await accountsService.getEarningsSummary(id));
  });

  app.get("/api/minecraft/accounts/:id/inventory", async (req, reply) => {
    const { id } = req.params as { id: string };
    const account = await accountsService.getAccountForSession(req.session!, id);
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    // Ask the bot for a fresh snapshot (arrives asynchronously, picked up by the
    // next poll) and return whatever we currently have.
    clientManager.requestInventory(id);
    reply.send({ inventory: clientManager.getInventory(id) ?? null });
  });

  // ---- Management ----
  // Creating an account is open to any authenticated user (they become the
  // sole assignee automatically); editing/deleting an account is allowed for
  // admins OR any user already assigned to it. Granting *other* users access
  // (the /assignments endpoint below) stays admin-only by design.

  app.post("/api/minecraft/accounts", { preHandler: app.requireCsrf }, async (req, reply) => {
    const body = parseOrReject(createAccountSchema, req.body, reply);
    if (!body) return;

    const account = await accountsService.createAccount(body, req.session!).catch((err) => {
      if (err.code === "P2002") {
        reply.code(409).send({ error: "Account name already exists" });
        return null;
      }
      throw err;
    });
    if (!account) return;

    const full = await accountsService.getFullAccount(account.id);
    if (full) clientManager.register(full);

    await recordAuditLog({
      userId: req.session!.user.id,
      action: "ACCOUNT_CREATE",
      targetType: "MinecraftAccount",
      targetId: account.id,
      details: { name: account.name, serverHost: account.serverHost },
    });
    reply.code(201).send(account);
  });

  app.patch("/api/minecraft/accounts/:id", { preHandler: app.requireCsrf }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOrReject(updateAccountSchema, req.body, reply);
    if (!body) return;

    const allowed = await accountsService.canAccessAccount(req.session!, id);
    if (!allowed) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }

    const account = await accountsService.updateAccount(id, body).catch(() => null);
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }

    const full = await accountsService.getFullAccount(id);
    if (full) clientManager.register(full);

    // Changing the Minecraft version only takes effect on the next
    // connection, so if the client is currently connected we proactively
    // restart it — this makes the version dropdown feel "live" instead of
    // silently doing nothing until the user manually restarts.
    if (body.minecraftVersion !== undefined) {
      const liveStatus = clientManager.get(id)?.getStatus().status;
      if (liveStatus && liveStatus !== "OFFLINE") {
        await clientManager.restart(id);
      }
    }

    await recordAuditLog({
      userId: req.session!.user.id,
      action: "ACCOUNT_UPDATE",
      targetType: "MinecraftAccount",
      targetId: id,
      details: body,
    });
    reply.send(account);
  });

  app.delete("/api/minecraft/accounts/:id", { preHandler: app.requireCsrf }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const allowed = await accountsService.canAccessAccount(req.session!, id);
    if (!allowed) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    clientManager.unregister(id);
    await accountsService.deleteAccount(id).catch(() => undefined);
    await recordAuditLog({
      userId: req.session!.user.id,
      action: "ACCOUNT_DELETE",
      targetType: "MinecraftAccount",
      targetId: id,
    });
    reply.code(204).send();
  });

  app.put(
    "/api/minecraft/accounts/:id/assignments",
    { preHandler: [app.requireAdmin, app.requireCsrf] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseOrReject(assignUsersSchema, req.body, reply);
      if (!body) return;

      await accountsService.setAssignments(id, body.userIds);
      await recordAuditLog({
        userId: req.session!.user.id,
        action: "ACCOUNT_ASSIGN",
        targetType: "MinecraftAccount",
        targetId: id,
        details: { userIds: body.userIds },
      });
      reply.send({ ok: true });
    },
  );

  // ---- Lifecycle control (assigned users or admin) ----

  app.post("/api/minecraft/accounts/:id/start", { preHandler: app.requireCsrf }, async (req, reply) => {
    await guardedLifecycle(req, reply, (id) => {
      const started = clientManager.start(id);
      return started;
    }, "ACCOUNT_START");
  });

  app.post("/api/minecraft/accounts/:id/stop", { preHandler: app.requireCsrf }, async (req, reply) => {
    await guardedLifecycle(req, reply, (id) => clientManager.stop(id), "ACCOUNT_STOP");
  });

  app.post("/api/minecraft/accounts/:id/restart", { preHandler: app.requireCsrf }, async (req, reply) => {
    await guardedLifecycle(req, reply, (id) => clientManager.restart(id), "ACCOUNT_RESTART");
  });

  app.post(
    "/api/minecraft/accounts/:id/clean-spawner",
    { preHandler: app.requireCsrf },
    async (req, reply) => {
      await guardedLifecycle(req, reply, (id) => clientManager.cleanSpawner(id), "ACCOUNT_CLEAN_SPAWNER");
    },
  );

  app.post(
    "/api/minecraft/accounts/:id/inventory/move",
    { preHandler: app.requireCsrf },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseOrReject(moveItemSchema, req.body, reply);
      if (!body) return;
      const allowed = await accountsService.canAccessAccount(req.session!, id);
      if (!allowed) {
        reply.code(404).send({ error: "Account not found" });
        return;
      }
      if (!clientManager.moveInventoryItem(id, body.from, body.to)) {
        reply.code(409).send({ error: "Bot is not online" });
        return;
      }
      reply.send({ ok: true });
    },
  );

  app.post(
    "/api/minecraft/accounts/:id/inventory/drop",
    { preHandler: app.requireCsrf },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseOrReject(dropItemSchema, req.body, reply);
      if (!body) return;
      const allowed = await accountsService.canAccessAccount(req.session!, id);
      if (!allowed) {
        reply.code(404).send({ error: "Account not found" });
        return;
      }
      if (!clientManager.dropInventoryItem(id, body.slot)) {
        reply.code(409).send({ error: "Bot is not online" });
        return;
      }
      reply.send({ ok: true });
    },
  );

  app.post("/api/minecraft/accounts/:id/command", { preHandler: app.requireCsrf }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOrReject(commandSchema, req.body, reply);
    if (!body) return;

    const result = await executeCommand(req.session!, id, body.command);
    if (!result.ok) {
      const codes = { FORBIDDEN: 403, NOT_FOUND: 404, OFFLINE: 409 } as const;
      reply.code(codes[result.reason]).send({ error: result.reason });
      return;
    }

    await recordAuditLog({
      userId: req.session!.user.id,
      action: "ACCOUNT_COMMAND",
      targetType: "MinecraftAccount",
      targetId: id,
      details: { command: body.command },
    });
    reply.send({ ok: true });
  });

  async function guardedLifecycle(
    req: FastifyRequest,
    reply: FastifyReply,
    action: (id: string) => boolean | Promise<boolean>,
    auditAction: string,
  ) {
    const { id } = req.params as { id: string };
    const allowed = await accountsService.canAccessAccount(req.session!, id);
    if (!allowed) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    const account = await prisma.minecraftAccount.findUnique({ where: { id } });
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    const ok = await action(id);
    if (!ok) {
      reply.code(500).send({ error: "Operation failed" });
      return;
    }
    await recordAuditLog({ userId: req.session!.user.id, action: auditAction, targetType: "MinecraftAccount", targetId: id });
    reply.send({ ok: true });
  }
}
