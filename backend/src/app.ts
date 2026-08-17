import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { config } from "./config/config.js";
import { logger } from "./logging/logger.js";
import authPlugin from "./auth/plugin.js";
import authRoutes from "./auth/routes.js";
import usersRoutes from "./users/routes.js";
import accountsRoutes from "./accounts/routes.js";
import systemRoutes from "./api/systemRoutes.js";
import auditLogRoutes from "./api/auditLogRoutes.js";
import registerWebsocketRoutes from "./websocket/routes.js";

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true, // required so req.ip is correct behind Caddy/Cloudflare
  });

  // ---- Security headers ----
  await app.register(helmet, {
    contentSecurityPolicy: config.isProduction
      ? undefined // frontend is a separate static build; configure CSP at the reverse proxy if needed
      : false,
  });

  // ---- CORS (only relevant when frontend is served from a different origin, e.g. local dev) ----
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
  });

  // ---- Rate limiting (global baseline; login route has a stricter override) ----
  await app.register(rateLimit, {
    max: 200,
    timeWindow: "1 minute",
  });

  await app.register(cookie, { secret: config.session.secret });
  await app.register(websocket);

  await app.register(authPlugin);

  await app.register(authRoutes);
  await app.register(usersRoutes);
  await app.register(accountsRoutes);
  await app.register(systemRoutes);
  await app.register(auditLogRoutes);
  await app.register(registerWebsocketRoutes);

  app.get("/api/health", async () => ({ status: "ok" }));

  app.setErrorHandler((err: import("fastify").FastifyError, req, reply) => {
    req.log.error({ err }, "Unhandled request error");
    const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(statusCode).send({
      error: statusCode === 500 ? "Internal server error" : err.message,
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: "Not found" });
  });

  return app;
}
