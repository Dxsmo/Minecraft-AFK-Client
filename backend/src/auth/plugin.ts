import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession, type SessionContext } from "./session.js";
import { config } from "../config/config.js";

declare module "fastify" {
  interface FastifyRequest {
    session: SessionContext | null;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireCsrf: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Attaches the current session (if any) to every request, and exposes
 * `requireAuth` / `requireAdmin` / `requireCsrf` guards used as Fastify
 * `preHandler` hooks by protected routes.
 */
export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorateRequest("session", null);

  app.addHook("preHandler", async (req) => {
    const sessionId = req.cookies?.[config.session.cookieName];
    req.session = sessionId ? await getSession(sessionId) : null;
  });

  app.decorate("requireAuth", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.session) {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.decorate("requireAdmin", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.session) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    if (req.session.user.role !== "ADMIN") {
      reply.code(403).send({ error: "Forbidden: admin role required" });
    }
  });

  // CSRF protection using the double-submit cookie pattern: the frontend
  // reads the non-httpOnly `afk_csrf` cookie and echoes it back as the
  // `x-csrf-token` header on every mutating request. Since cross-origin
  // pages cannot read our cookies, this proves the request originated from
  // our own frontend even though the session cookie is sent automatically.
  app.decorate("requireCsrf", async (req: FastifyRequest, reply: FastifyReply) => {
    if (SAFE_METHODS.has(req.method)) return;
    if (!req.session) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const headerToken = req.headers["x-csrf-token"];
    if (!headerToken || headerToken !== req.session.csrfToken) {
      reply.code(403).send({ error: "Invalid or missing CSRF token" });
    }
  });
});
