import type { FastifyInstance } from "fastify";
import {
  createSniperAccountSchema,
  updateSniperAccountSchema,
  reorderSniperAccountsSchema,
} from "./schemas.js";
import * as sniperService from "./service.js";
import { sniperManager } from "./SniperManager.js";
import { getSniperLogs } from "../logging/sniperLogService.js";
import { parseOrReject } from "../utils/validate.js";
import { recordAuditLog } from "../logging/auditLog.js";

/**
 * Admin-only Name Sniper API. Mirrors accounts/routes.ts closely but is a
 * completely independent feature — no shared rows/state with MinecraftAccount.
 */
export default async function namesniperRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAdmin);

  app.get("/api/namesniper/accounts", async (_req, reply) => {
    const accounts = await sniperService.listSniperAccounts();
    const statuses = new Map(sniperManager.getAllStatuses().map((s) => [s.id, s]));
    reply.send(accounts.map((a) => ({ ...a, live: statuses.get(a.id) })));
  });

  app.get("/api/namesniper/accounts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const account = await sniperService.getSniperAccount(id);
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    reply.send({ ...account, live: sniperManager.get(id)?.getStatus() });
  });

  app.get("/api/namesniper/accounts/:id/logs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const account = await sniperService.getSniperAccount(id);
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    const { limit } = req.query as { limit?: string };
    reply.send(await getSniperLogs(id, limit ? Number(limit) : undefined));
  });

  app.post("/api/namesniper/accounts", { preHandler: app.requireCsrf }, async (req, reply) => {
    const body = parseOrReject(createSniperAccountSchema, req.body, reply);
    if (!body) return;

    const account = await sniperService.createSniperAccount(body, req.session!).catch((err) => {
      if (err.code === "P2002") {
        reply.code(409).send({ error: "This email is already used by another Name Sniper account" });
        return null;
      }
      throw err;
    });
    if (!account) return;

    const full = await sniperService.getFullSniperAccount(account.id);
    if (full) sniperManager.register(full);

    await recordAuditLog({
      userId: req.session!.user.id,
      action: "SNIPER_ACCOUNT_CREATE",
      targetType: "SniperAccount",
      targetId: account.id,
      details: { label: account.label, email: account.email },
    });
    reply.code(201).send(account);
  });

  app.patch("/api/namesniper/accounts/:id", { preHandler: app.requireCsrf }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOrReject(updateSniperAccountSchema, req.body, reply);
    if (!body) return;

    const account = await sniperService.updateSniperAccount(id, body).catch(() => null);
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }

    const full = await sniperService.getFullSniperAccount(id);
    if (full) sniperManager.register(full);

    await recordAuditLog({
      userId: req.session!.user.id,
      action: "SNIPER_ACCOUNT_UPDATE",
      targetType: "SniperAccount",
      targetId: id,
      details: body,
    });
    reply.send(account);
  });

  app.delete("/api/namesniper/accounts/:id", { preHandler: app.requireCsrf }, async (req, reply) => {
    const { id } = req.params as { id: string };
    sniperManager.unregister(id);
    await sniperService.deleteSniperAccount(id).catch(() => undefined);
    await recordAuditLog({
      userId: req.session!.user.id,
      action: "SNIPER_ACCOUNT_DELETE",
      targetType: "SniperAccount",
      targetId: id,
    });
    reply.code(204).send();
  });

  app.put(
    "/api/namesniper/accounts/reorder",
    { preHandler: app.requireCsrf },
    async (req, reply) => {
      const body = parseOrReject(reorderSniperAccountsSchema, req.body, reply);
      if (!body) return;
      const ok = await sniperService.reorderSniperAccounts(body.accountIds);
      if (!ok) {
        reply.code(400).send({ error: "Invalid account order payload" });
        return;
      }
      await recordAuditLog({
        userId: req.session!.user.id,
        action: "SNIPER_ACCOUNT_REORDER",
        targetType: "SniperAccount",
        details: { count: body.accountIds.length },
      });
      reply.send({ ok: true });
    },
  );

  app.post("/api/namesniper/accounts/:id/start", { preHandler: app.requireCsrf }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const account = await sniperService.getFullSniperAccount(id);
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    if (!account.desiredName.trim()) {
      reply.code(409).send({ error: "Set a desired name before starting the sniper" });
      return;
    }
    const ok = sniperManager.start(id);
    if (!ok) {
      reply.code(500).send({ error: "Operation failed" });
      return;
    }
    await recordAuditLog({
      userId: req.session!.user.id,
      action: "SNIPER_ACCOUNT_START",
      targetType: "SniperAccount",
      targetId: id,
      details: { desiredName: account.desiredName },
    });
    reply.send({ ok: true });
  });

  app.post("/api/namesniper/accounts/:id/stop", { preHandler: app.requireCsrf }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = sniperManager.stop(id);
    if (!ok) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    await recordAuditLog({
      userId: req.session!.user.id,
      action: "SNIPER_ACCOUNT_STOP",
      targetType: "SniperAccount",
      targetId: id,
    });
    reply.send({ ok: true });
  });
}
