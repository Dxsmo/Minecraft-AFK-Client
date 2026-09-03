import type { FastifyInstance } from "fastify";
import net from "node:net";
import { z } from "zod";
import { parseOrReject } from "../utils/validate.js";
import { recordAuditLog } from "../logging/auditLog.js";
import { banIp, unbanIp, listBannedIps } from "./ipBans.js";

const banIpSchema = z.object({
  ip: z
    .string()
    .trim()
    .max(45)
    .refine((v) => net.isIP(v) !== 0, { message: "Must be a valid IPv4 or IPv6 address" }),
  reason: z.string().max(200).optional(),
});

/** Admin-only IP ban management. */
export default async function securityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAdmin);

  app.get("/api/security/ip-bans", async (_req, reply) => {
    reply.send(await listBannedIps());
  });

  app.post("/api/security/ip-bans", { preHandler: app.requireCsrf }, async (req, reply) => {
    const body = parseOrReject(banIpSchema, req.body, reply);
    if (!body) return;
    // Never let an admin lock themselves out via the IP they're calling from.
    if (body.ip === req.ip) {
      reply.code(400).send({ error: "You cannot ban your own current IP address" });
      return;
    }
    await banIp(body.ip, { reason: body.reason, createdById: req.session!.user.id });
    await recordAuditLog({
      userId: req.session!.user.id,
      action: "IP_BAN",
      targetType: "BannedIp",
      targetId: body.ip,
      details: { reason: body.reason },
    });
    reply.code(201).send({ ok: true });
  });

  app.delete("/api/security/ip-bans/:ip", { preHandler: app.requireCsrf }, async (req, reply) => {
    const { ip } = req.params as { ip: string };
    await unbanIp(ip);
    await recordAuditLog({
      userId: req.session!.user.id,
      action: "IP_UNBAN",
      targetType: "BannedIp",
      targetId: ip,
    });
    reply.code(204).send();
  });
}
