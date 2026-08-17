import type { FastifyInstance } from "fastify";
import { createUserSchema, updateUserSchema } from "./schemas.js";
import * as usersService from "./service.js";
import { parseOrReject } from "../utils/validate.js";
import { recordAuditLog } from "../logging/auditLog.js";

/**
 * All routes here are admin-only: normal users cannot list, create, edit or
 * delete other accounts. Ownership of Minecraft accounts is handled by the
 * separate `accounts` module.
 */
export default async function usersRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAdmin);

  app.get("/api/users", async (_req, reply) => {
    reply.send(await usersService.listUsers());
  });

  app.get("/api/users/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = await usersService.getUserById(id);
    if (!user) {
      reply.code(404).send({ error: "User not found" });
      return;
    }
    reply.send(user);
  });

  app.post("/api/users", { preHandler: app.requireCsrf }, async (req, reply) => {
    const body = parseOrReject(createUserSchema, req.body, reply);
    if (!body) return;

    const user = await usersService.createUser(body).catch((err) => {
      if (err.code === "P2002") {
        reply.code(409).send({ error: "Username already taken" });
        return null;
      }
      throw err;
    });
    if (!user) return;

    await recordAuditLog({
      userId: req.session!.user.id,
      action: "USER_CREATE",
      targetType: "User",
      targetId: user.id,
      details: { username: user.username, role: user.role },
    });
    reply.code(201).send(user);
  });

  app.patch("/api/users/:id", { preHandler: app.requireCsrf }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOrReject(updateUserSchema, req.body, reply);
    if (!body) return;

    // Prevent demoting/disabling the last remaining active admin.
    if (body.role === "USER" || body.status === "DISABLED") {
      const target = await usersService.getUserById(id);
      if (target?.role === "ADMIN") {
        const adminCount = await usersService.countAdmins();
        if (adminCount <= 1) {
          reply.code(400).send({ error: "Cannot remove the last remaining admin" });
          return;
        }
      }
    }

    const user = await usersService.updateUser(id, body);
    await recordAuditLog({
      userId: req.session!.user.id,
      action: "USER_UPDATE",
      targetType: "User",
      targetId: id,
      details: { role: body.role, status: body.status, passwordChanged: !!body.password },
    });
    reply.send(user);
  });

  app.delete("/api/users/:id", { preHandler: app.requireCsrf }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.session!.user.id) {
      reply.code(400).send({ error: "You cannot delete your own account" });
      return;
    }
    const target = await usersService.getUserById(id);
    if (target?.role === "ADMIN") {
      const adminCount = await usersService.countAdmins();
      if (adminCount <= 1) {
        reply.code(400).send({ error: "Cannot delete the last remaining admin" });
        return;
      }
    }
    await usersService.deleteUser(id);
    await recordAuditLog({ userId: req.session!.user.id, action: "USER_DELETE", targetType: "User", targetId: id });
    reply.code(204).send();
  });
}
