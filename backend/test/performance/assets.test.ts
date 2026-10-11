import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../src/app.js";
import { prisma } from "../../src/database/prisma.js";
import { createSession } from "../../src/auth/session.js";
import { config } from "../../src/config/config.js";

it("loads more than 200 public icons without session reads or exhausting the protected API budget", async () => {
  const user = await prisma.user.create({ data: { username: `textures-${randomUUID()}`, passwordHash: "test" } });
  const session = await createSession(user.id, {});
  const app = await buildApp();
  const lookup = vi.spyOn(prisma.session, "findUnique");
  const headers = { cookie: `${config.session.cookieName}=${session.sessionId}` };
  try {
    for (let batch = 0; batch < 9; batch++) {
      const images = await Promise.all(Array.from({ length: 25 }, () => app.inject({ url: "/api/assets/item/stone.png", headers })));
      expect(images.every(image => image.statusCode === 200)).toBe(true);
    }
    expect(lookup).not.toHaveBeenCalled();
    const accounts = await app.inject({ url: "/api/minecraft/accounts?view=dashboard", headers });
    expect(accounts.statusCode).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
  } finally {
    lookup.mockRestore();
    await app.close();
    await prisma.user.delete({ where: { id: user.id } });
  }
});
