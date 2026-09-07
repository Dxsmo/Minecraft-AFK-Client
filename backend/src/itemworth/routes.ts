import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  itemWorthScanner,
  MIN_DELAY_SECONDS,
  MAX_DELAY_SECONDS,
} from "../minecraft/ItemWorthScanner.js";
import { clientManager } from "../minecraft/ClientManager.js";
import { prisma } from "../database/prisma.js";
import { parseOrReject } from "../utils/validate.js";
import { recordAuditLog } from "../logging/auditLog.js";

const startScanSchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1).max(50),
  delaySeconds: z.number().int().min(MIN_DELAY_SECONDS).max(MAX_DELAY_SECONDS),
});

/**
 * Site-wide "Item Wert" price scan. Admin-only: the whole feature (including
 * merely knowing it exists) is hidden from normal users, so every route 404s
 * for them rather than 403ing.
 */
export default async function itemWorthRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAuth);
  app.addHook("preHandler", async (req, reply) => {
    if (req.session!.user.role === "ADMIN") return;
    reply.code(404).send({ error: "Not found" });
  });

  /** Scan state plus the accounts that may take part, with live online status. */
  app.get("/api/item-worth", async (_req, reply) => {
    const [state, accounts] = await Promise.all([
      itemWorthScanner.getState(),
      prisma.minecraftAccount.findMany({
        orderBy: [{ dashboardOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true, displayName: true },
      }),
    ]);

    reply.send({
      ...state,
      accounts: accounts.map((account) => {
        const status = clientManager.get(account.id)?.getStatus().status ?? "OFFLINE";
        return {
          id: account.id,
          name: account.name,
          displayName: account.displayName,
          status,
          // Only an online bot can answer /worth, so the UI greys out the rest.
          online: status === "ONLINE",
        };
      }),
    });
  });

  app.post("/api/item-worth/start", { preHandler: app.requireCsrf }, async (req, reply) => {
    const body = parseOrReject(startScanSchema, req.body, reply);
    if (!body) return;

    // Only accept accounts that exist AND are online right now — the client's
    // idea of who is online can be seconds stale.
    const known = await prisma.minecraftAccount.findMany({
      where: { id: { in: body.accountIds } },
      select: { id: true },
    });
    const eligible = known
      .map((account) => account.id)
      .filter((id) => clientManager.get(id)?.getStatus().status === "ONLINE");

    if (eligible.length === 0) {
      reply.code(400).send({ error: "Keiner der gewählten Accounts ist online" });
      return;
    }

    try {
      await itemWorthScanner.start(eligible, body.delaySeconds);
    } catch (err) {
      reply.code(409).send({ error: err instanceof Error ? err.message : "Failed to start scan" });
      return;
    }

    await recordAuditLog({
      userId: req.session!.user.id,
      action: "ITEM_WORTH_SCAN_START",
      details: { accountIds: eligible, delaySeconds: body.delaySeconds },
    });
    reply.send(await itemWorthScanner.getState());
  });

  app.post("/api/item-worth/stop", { preHandler: app.requireCsrf }, async (req, reply) => {
    await itemWorthScanner.stop();
    await recordAuditLog({ userId: req.session!.user.id, action: "ITEM_WORTH_SCAN_STOP" });
    reply.send(await itemWorthScanner.getState());
  });
}
