import os from "node:os";
import type { FastifyInstance } from "fastify";
import { clientManager } from "../minecraft/ClientManager.js";

const startedAt = Date.now();

/**
 * Lightweight system status endpoint. Uses only cheap, built-in `os` module
 * calls (no external monitoring agent) to keep resource usage minimal on a
 * Raspberry Pi. CPU load is a 1-minute average snapshot, not a live sampler.
 */
export default async function systemRoutes(app: FastifyInstance) {
  app.get("/api/system/status", { preHandler: app.requireAuth }, async (req, reply) => {
    const statuses = clientManager.getAllStatuses();
    const visible =
      req.session!.user.role === "ADMIN"
        ? statuses
        : statuses.filter(() => false); // non-admins get counts via /api/minecraft/accounts instead

    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    reply.send({
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      systemUptimeSeconds: os.uptime(),
      cpu: {
        loadAvg1m: os.loadavg()[0],
        cores: os.cpus().length,
      },
      memory: {
        totalBytes: totalMem,
        freeBytes: freeMem,
        usedBytes: totalMem - freeMem,
      },
      clients: {
        total: statuses.length,
        online: statuses.filter((s) => s.status === "ONLINE").length,
        offline: statuses.filter((s) => s.status === "OFFLINE").length,
        error: statuses.filter((s) => s.status === "ERROR").length,
      },
      visibleClients: req.session!.user.role === "ADMIN" ? visible : undefined,
    });
  });
}
