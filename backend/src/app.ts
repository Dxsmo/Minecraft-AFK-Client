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
import { getItemTexture, listItemNames } from "./assets/itemTextures.js";

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

  // Public item/block texture endpoint (no auth — textures aren't sensitive).
  // Served from the pre-fetched Minecraft Wiki icon set (see
  // scripts/fetch-invicons.mjs) so the inventory UI can show real Minecraft
  // icons instead of raw ids. 404 lets the frontend fall back.
  app.get("/api/assets/item/:name", async (req, reply) => {
    const raw = String((req.params as { name: string }).name).replace(/\.png$/i, "");
    const buf = getItemTexture(raw);
    if (!buf) return reply.code(404).send();
    return reply
      .header("Content-Type", "image/png")
      .header("Cache-Control", "public, max-age=604800, immutable")
      .send(buf);
  });

  // Public list of every valid icon id, for the dashboard account icon picker.
  // The frontend shows names with "_" replaced by spaces, so matching accepts
  // the query in either form (e.g. "diamond sword" finds "diamond_sword").
  // Every texture the game has is included — nothing is pre-filtered out.
  app.get("/api/assets/items", async (req, reply) => {
    const rawQuery = String((req.query as { q?: string }).q ?? "").trim().toLowerCase();
    const all = listItemNames();
    let filtered = all;
    if (rawQuery) {
      // Match all whitespace-separated tokens (in any order) against the
      // display form of the name, so partial multi-word searches work too.
      const tokens = rawQuery.split(/\s+/).filter(Boolean);
      filtered = all.filter((name) => {
        const display = name.replace(/_/g, " ");
        return tokens.every((t) => display.includes(t) || name.includes(t));
      });
    }
    // Cap comfortably above the full icon catalogue size (~5.1k) so every
    // icon remains reachable via search; only the query-less "browse all"
    // case is ever near this limit, and thumbnails load lazily client-side.
    return reply
      .header("Cache-Control", "public, max-age=604800, immutable")
      .send(filtered.slice(0, 5200));
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
