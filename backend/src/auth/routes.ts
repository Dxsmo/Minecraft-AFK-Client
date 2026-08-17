import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../database/prisma.js";
import { verifyPassword, hashPassword } from "./password.js";
import { createSession, destroySession, destroyAllUserSessions } from "./session.js";
import { config } from "../config/config.js";
import { parseOrReject } from "../utils/validate.js";
import { recordAuditLog } from "../logging/auditLog.js";
import { logger } from "../logging/logger.js";

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
});

const cookieOpts = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.session.cookieSecure,
};

export default async function authRoutes(app: FastifyInstance) {
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: config.loginRateLimit.max, timeWindow: config.loginRateLimit.window } } },
    async (req, reply) => {
      const body = parseOrReject(loginSchema, req.body, reply);
      if (!body) return;

      const user = await prisma.user.findUnique({ where: { username: body.username } });

      // Constant-shape response to avoid leaking whether the username exists.
      if (!user || user.status === "DISABLED") {
        logger.warn({ username: body.username }, "Login failed: unknown or disabled user");
        reply.code(401).send({ error: "Invalid username or password" });
        return;
      }

      const valid = await verifyPassword(user.passwordHash, body.password);
      if (!valid) {
        logger.warn({ username: body.username }, "Login failed: bad password");
        reply.code(401).send({ error: "Invalid username or password" });
        return;
      }

      const { sessionId, csrfToken, expiresAt } = await createSession(user.id, {
        userAgent: req.headers["user-agent"],
        ipAddress: req.ip,
      });

      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await recordAuditLog({ userId: user.id, action: "USER_LOGIN", targetType: "User", targetId: user.id });

      reply
        .setCookie(config.session.cookieName, sessionId, { ...cookieOpts, expires: expiresAt })
        // Non-httpOnly so the SPA can read it and echo it back as a CSRF header.
        .setCookie("afk_csrf", csrfToken, { ...cookieOpts, httpOnly: false, expires: expiresAt })
        .send({ id: user.id, username: user.username, role: user.role });
    },
  );

  app.post("/api/auth/logout", { preHandler: [app.requireAuth] }, async (req, reply) => {
    if (req.session) {
      await destroySession(req.session.sessionId);
      await recordAuditLog({ userId: req.session.user.id, action: "USER_LOGOUT" });
    }
    reply
      .clearCookie(config.session.cookieName, { path: "/" })
      .clearCookie("afk_csrf", { path: "/" })
      .send({ ok: true });
  });

  app.get("/api/auth/me", { preHandler: [app.requireAuth] }, async (req, reply) => {
    reply.send({ user: req.session!.user, csrfToken: req.session!.csrfToken });
  });

  // Self-service password change: any authenticated user may change their
  // own password (distinct from the admin-only /api/users/:id endpoint).
  app.post(
    "/api/auth/change-password",
    { preHandler: [app.requireAuth, app.requireCsrf] },
    async (req, reply) => {
      const body = parseOrReject(changePasswordSchema, req.body, reply);
      if (!body) return;

      const user = await prisma.user.findUnique({ where: { id: req.session!.user.id } });
      if (!user || !(await verifyPassword(user.passwordHash, body.currentPassword))) {
        reply.code(401).send({ error: "Current password is incorrect" });
        return;
      }

      const passwordHash = await hashPassword(body.newPassword);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
      await destroyAllUserSessions(user.id);

      const { sessionId, csrfToken, expiresAt } = await createSession(user.id, {
        userAgent: req.headers["user-agent"],
        ipAddress: req.ip,
      });
      await recordAuditLog({ userId: user.id, action: "USER_CHANGE_PASSWORD", targetType: "User", targetId: user.id });

      reply
        .setCookie(config.session.cookieName, sessionId, { ...cookieOpts, expires: expiresAt })
        .setCookie("afk_csrf", csrfToken, { ...cookieOpts, httpOnly: false, expires: expiresAt })
        .send({ ok: true });
    },
  );
}
