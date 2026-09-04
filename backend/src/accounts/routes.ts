import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createAccountSchema,
  updateAccountSchema,
  assignUsersSchema,
  reorderAccountsSchema,
  commandSchema,
  moveItemSchema,
  dropItemSchema,
  setHugoSettingSchema,
  stripAdminOnlyFields,
  stripAdminOnlyCreateFields,
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

  /**
   * Guard for the admin-only account features (live inventory, server settings
   * GUI, spawner/behavior tuning). Normal users work with a reduced feature set,
   * and that reduction is enforced here rather than only in the UI. Answers 404
   * so the endpoint's existence isn't leaked to non-admins.
   */
  function requireAdminFeature(req: FastifyRequest, reply: FastifyReply): boolean {
    if (req.session!.user.role === "ADMIN") return true;
    reply.code(404).send({ error: "Account not found" });
    return false;
  }

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
    if (!requireAdminFeature(req, reply)) return;
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
  // is allowed for admins and for the account's creator/operator.

  app.post("/api/minecraft/accounts", { preHandler: app.requireCsrf }, async (req, reply) => {
    const body = parseOrReject(createAccountSchema, req.body, reply);
    if (!body) return;

    // Same gate as the PATCH below: a non-admin must not be able to set
    // admin-only settings by supplying them at creation time (they'd otherwise
    // stick forever, since the update path strips them).
    const input =
      req.session!.user.role === "ADMIN" ? body : stripAdminOnlyCreateFields(body);

    const account = await accountsService.createAccount(input, req.session!).catch((err) => {
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

    // Non-admins may only change the basic account fields; anything admin-only
    // is dropped server-side so a hand-crafted request can't bypass the UI.
    const data = req.session!.user.role === "ADMIN" ? body : stripAdminOnlyFields(body);

    const account = await accountsService.updateAccount(id, data).catch(() => null);
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
    "/api/minecraft/accounts/reorder",
    { preHandler: app.requireCsrf },
    async (req, reply) => {
      const body = parseOrReject(reorderAccountsSchema, req.body, reply);
      if (!body) return;
      const ok = await accountsService.reorderAccountsForSession(req.session!, body.accountIds);
      if (!ok) {
        reply.code(400).send({ error: "Invalid account order payload" });
        return;
      }
      await recordAuditLog({
        userId: req.session!.user.id,
        action: "ACCOUNT_REORDER",
        targetType: "MinecraftAccount",
        details: { count: body.accountIds.length },
      });
      reply.send({ ok: true });
    },
  );

  app.put(
    "/api/minecraft/accounts/:id/assignments",
    { preHandler: app.requireCsrf },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      // Admins and the account's own operator/creator may manage access.
      if (!(await accountsService.canManageAssignments(req.session!, id))) {
        reply.code(404).send({ error: "Account not found" });
        return;
      }
      const body = parseOrReject(assignUsersSchema, req.body, reply);
      if (!body) return;

      // A non-admin operator must never accidentally remove their own access to
      // an account they manage, so their own id is always kept in the set.
      const userIds =
        req.session!.user.role === "ADMIN"
          ? body.userIds
          : Array.from(new Set([...body.userIds, req.session!.user.id]));

      await accountsService.setAssignments(id, userIds);
      await recordAuditLog({
        userId: req.session!.user.id,
        action: "ACCOUNT_ASSIGN",
        targetType: "MinecraftAccount",
        targetId: id,
        details: { userIds },
      });
      reply.send({ ok: true });
    },
  );

  // Users selectable in the access picker. Restricted to those allowed to manage
  // the account's access (admin or the account's creator/operator).
  app.get("/api/minecraft/accounts/:id/assignable-users", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await accountsService.canManageAssignments(req.session!, id))) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    reply.send(await accountsService.listAssignableUsers());
  });

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

  // ---- Server settings GUI (e.g. HugoSMP "/settings") ----

  app.get("/api/minecraft/accounts/:id/hugo-settings", async (req, reply) => {
    if (!requireAdminFeature(req, reply)) return;
    const { id } = req.params as { id: string };
    const account = await accountsService.getAccountForSession(req.session!, id);
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    // Prefer the live in-memory list (freshest); fall back to the persisted one.
    const live = clientManager.getHugoSettings(id);
    reply.send({ settings: live ?? account.hugoSettings ?? [] });
  });

  app.post(
    "/api/minecraft/accounts/:id/hugo-settings/scan",
    { preHandler: app.requireCsrf },
    async (req, reply) => {
      if (!requireAdminFeature(req, reply)) return;
      const { id } = req.params as { id: string };
      const allowed = await accountsService.canAccessAccount(req.session!, id);
      if (!allowed) {
        reply.code(404).send({ error: "Account not found" });
        return;
      }
      if (!clientManager.scanHugoSettings(id)) {
        reply.code(409).send({ error: "Bot is not online" });
        return;
      }
      reply.send({ ok: true });
    },
  );

  app.post(
    "/api/minecraft/accounts/:id/hugo-settings/set",
    { preHandler: app.requireCsrf },
    async (req, reply) => {
      if (!requireAdminFeature(req, reply)) return;
      const { id } = req.params as { id: string };
      const body = parseOrReject(setHugoSettingSchema, req.body, reply);
      if (!body) return;
      const allowed = await accountsService.canAccessAccount(req.session!, id);
      if (!allowed) {
        reply.code(404).send({ error: "Account not found" });
        return;
      }
      if (!clientManager.setHugoSetting(id, body.label, body.enabled)) {
        reply.code(409).send({ error: "Bot is not online" });
        return;
      }
      await recordAuditLog({
        userId: req.session!.user.id,
        action: "ACCOUNT_HUGO_SETTING",
        targetType: "MinecraftAccount",
        targetId: id,
        details: { label: body.label, enabled: body.enabled },
      });
      reply.send({ ok: true });
    },
  );

  app.post(
    "/api/minecraft/accounts/:id/inventory/move",
    { preHandler: app.requireCsrf },
    async (req, reply) => {
      if (!requireAdminFeature(req, reply)) return;
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
      if (!requireAdminFeature(req, reply)) return;
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
