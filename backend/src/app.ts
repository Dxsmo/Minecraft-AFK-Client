import Fastify from "fastify";
import minigameRoutes from "./minigames/routes.js";
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
import itemWorthRoutes from "./itemworth/routes.js";
import systemRoutes from "./api/systemRoutes.js";
import auditLogRoutes from "./api/auditLogRoutes.js";
import securityRoutes from "./security/routes.js";
import { isIpBanned } from "./security/ipBans.js";
import registerWebsocketRoutes from "./websocket/routes.js";
import { getItemTexture } from "./assets/itemTextures.js";
import notesRoutes from "./notes/routes.js";
import { isTrustedOrigin, isWebsiteSocketPath } from "./security/origins.js";

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: config.trustedProxies,
  });

  // The browser can distinguish backend work from proxy/network delay in its
  // request timings. Log route templates only, never query strings or tokens.
  app.addHook("onSend", (_req, reply, payload, done) => {
    reply.header("Server-Timing", `app;dur=${reply.elapsedTime.toFixed(1)}`);
    done(null, payload);
  });
  app.addHook("onResponse", async (req, reply) => {
    if (reply.elapsedTime >= 1000) req.log.warn({
      route: req.routeOptions.url,
      durationMs: Math.round(reply.elapsedTime),
      statusCode: reply.statusCode,
    }, "Slow HTTP request");
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

  // Install upgrade cleanup before any hook can reject a WebSocket request.
  await app.register(websocket, { options: { maxPayload: 256 * 1024, perMessageDeflate: false } });

  // ---- IP ban guard ----
  // Reject any request from a banned IP as early as possible (before auth,
  // rate-limit accounting or route handlers do any work). Uses the in-memory
  // ban cache loaded at startup (see server.ts) for a synchronous lookup.
  app.addHook("onRequest", async (req, reply) => {
    if (isIpBanned(req.ip)) {
      return reply.code(403).send({ error: "Your IP address has been blocked" });
    }
    const origin = req.headers.origin;
    // The matched route also covers encoded spellings such as /ws/%64ashboard.
    const websiteSocket = isWebsiteSocketPath(req.routeOptions.url ?? req.url.split("?", 1)[0]);
    if ((websiteSocket || (origin !== undefined && !["GET", "HEAD", "OPTIONS"].includes(req.method))) &&
        !isTrustedOrigin(origin)) {
      return reply.code(403).send({ error: "Untrusted request origin" });
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

  await app.register(authPlugin);

  await app.register(authRoutes);
  await app.register(usersRoutes);
  await app.register(accountsRoutes);
  await app.register(notesRoutes);
  await app.register(namesniperRoutes);
  await app.register(itemWorthRoutes);
  await app.register(systemRoutes);
  await app.register(auditLogRoutes);
  await app.register(securityRoutes);
  await app.register(registerWebsocketRoutes);
  await app.register(minigameRoutes);

  app.get("/api/health", async () => ({ status: "ok" }));

  // Public item/block texture endpoint (no auth — textures aren't sensitive).
  // Served from the minecraft-assets package so item lists can show real
  // Minecraft icons instead of raw ids. 404 lets the frontend fall back.
  // A price list may load hundreds of immutable icons. They must not consume
  // the API budget and cause unrelated login/account/earnings requests to 429.
  app.get("/api/assets/item/:name", { config: { rateLimit: false } }, async (req, reply) => {
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
