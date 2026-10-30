import type { FastifyInstance } from "fastify";
import { prisma } from "../database/prisma.js";
import { z } from "zod";
import { parseOrReject } from "../utils/validate.js";
const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }).strict();

/** Admin-only endpoint to review the audit trail of critical actions. */
export default async function auditLogRoutes(app: FastifyInstance) {
  app.get("/api/audit-logs", { preHandler: app.requireAdmin }, async (req, reply) => {
    const query = parseOrReject(querySchema, req.query, reply);
    if (!query) return;
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: query.limit,
      include: { user: { select: { username: true } } },
    });
    reply.send(logs);
  });
}
