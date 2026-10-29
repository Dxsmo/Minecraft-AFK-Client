import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../src/app.js";
import { config } from "../../src/config/config.js";
import { createSession } from "../../src/auth/session.js";
import { prisma } from "../../src/database/prisma.js";
it("allows twice the configured login burst before responding 429", async () => {
  const app = await buildApp();
  try {
    expect(config.loginRateLimit.max).toBe(Number(process.env.LOGIN_RATE_LIMIT_MAX || 5) * 2);
    for (let i = 0; i < config.loginRateLimit.max; i++) {
      expect((await app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.41", payload: {} })).statusCode).toBe(400);
    }
    const blocked = await app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.41", payload: {} });
    expect(blocked.statusCode).toBe(429); expect(blocked.headers["retry-after"]).toBeDefined();
  } finally { await app.close(); }
});
it("allows 400 authenticated requests per minute and exempts catalog image loads", async () => {
  const app = await buildApp();
  const user = await prisma.user.create({ data: { username: `limit-${randomUUID()}`, passwordHash: "test" } });
  try {
    const session = await createSession(user.id, {});
    const request = { url: "/api/auth/me", remoteAddress: "198.51.100.42", headers: { cookie: `${config.session.cookieName}=${session.sessionId}` } };
    for (let i = 0; i < 400; i++) expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(429);
    expect((await app.inject({ url: "/api/assets/account-items/diamond_sword.png", remoteAddress: request.remoteAddress })).statusCode).toBe(200);
  } finally { await app.close(); await prisma.user.delete({ where: { id: user.id } }); }
});
