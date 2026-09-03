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
import namesniperRoutes from "./namesniper/routes.js";
import systemRoutes from "./api/systemRoutes.js";
import auditLogRoutes from "./api/auditLogRoutes.js";
import securityRoutes from "./security/routes.js";
import { isIpBanned } from "./security/ipBans.js";
import registerWebsocketRoutes from "./websocket/routes.js";
import { getItemTexture } from "./assets/itemTextures.js";

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true, // required so req.ip is correct behind Caddy/Cloudflare
  });

  // ---- Security headers ----
  await app.register(helmet, {
    // HSTS: force HTTPS for a year (incl. subdomains) in production. Harmless
    // in dev because SESSION_COOKIE_SECURE/HTTP there means browsers ignore it.
    hsts: config.isProduction
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
    contentSecurityPolicy: config.isProduction
      ? undefined // frontend is a separate static build; configure CSP at the reverse proxy if needed
      : false,
  });

  // ---- IP ban guard ----
  // Reject any request from a banned IP as early as possible (before auth,
  // rate-limit accounting or route handlers do any work). Uses the in-memory
  // ban cache loaded at startup (see server.ts) for a synchronous lookup.
  app.addHook("onRequest", async (req, reply) => {
    if (isIpBanned(req.ip)) {
      reply.code(403).send({ error: "Your IP address has been blocked" });
    }
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
  await app.register(namesniperRoutes);
  await app.register(systemRoutes);
  await app.register(auditLogRoutes);
  await app.register(securityRoutes);
  await app.register(registerWebsocketRoutes);

  app.get("/api/health", async () => ({ status: "ok" }));

  // Public item/block texture endpoint (no auth — textures aren't sensitive).
  // Served from the minecraft-assets package so the inventory UI can show real
  // Minecraft icons instead of raw ids. 404 lets the frontend fall back.
  app.get("/api/assets/item/:name", async (req, reply) => {
    const raw = String((req.params as { name: string }).name).replace(/\.png$/i, "");
    const buf = getItemTexture(raw);
    if (!buf) return reply.code(404).send();
    return reply
      .header("Content-Type", "image/png")
      .header("Cache-Control", "public, max-age=604800, immutable")
      .send(buf);
  });

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
