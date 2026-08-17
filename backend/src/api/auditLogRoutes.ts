import type { FastifyInstance } from "fastify";
import { prisma } from "../database/prisma.js";

/** Admin-only endpoint to review the audit trail of critical actions. */
export default async function auditLogRoutes(app: FastifyInstance) {
  app.get("/api/audit-logs", { preHandler: app.requireAdmin }, async (req, reply) => {
    const { limit } = req.query as { limit?: string };
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit ? Number(limit) : 200,
      include: { user: { select: { username: true } } },
    });
    reply.send(logs);
  });
}
