import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { PNG } from "pngjs";
import { buildApp } from "../../src/app.js";
import { prisma } from "../../src/database/prisma.js";
import { createSession } from "../../src/auth/session.js";
import { config } from "../../src/config/config.js";
import { MAX_ACCOUNT_IMAGE_BASE64 } from "../../src/accounts/images.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let accountId: string;
const users: string[] = [];
const sessions: { cookie: string; "x-csrf-token": string }[] = [];
const imagePath = () => `/api/minecraft/accounts/${accountId}/image`;
function png(red: number) {
  const image = new PNG({ width: 2, height: 2 });
  for (let i = 0; i < image.data.length; i += 4) image.data.set([red, 50, 90, 255], i);
  return PNG.sync.write(image);
}
const upload = (image: string, session = 1) => app.inject({ method: "PUT", url: imagePath(), headers: sessions[session], payload: { image } });

beforeAll(async () => {
  for (const role of ["ADMIN", "USER", "USER", "USER"] as const) {
    const user = await prisma.user.create({ data: { username: `image-${randomUUID().slice(0, 8)}`, passwordHash: "test", role } });
    users.push(user.id);
    const session = await createSession(user.id, {});
    sessions.push({ cookie: `${config.session.cookieName}=${session.sessionId}`, "x-csrf-token": session.csrfToken });
  }
  const account = await prisma.minecraftAccount.create({ data: {
    name: `Image_${randomUUID().slice(0, 8)}`, serverHost: "localhost",
    assignments: { create: users.slice(1, 3).map((userId) => ({ userId })) },
  } });
  accountId = account.id;
  app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await app?.close();
  await prisma.minecraftAccount.deleteMany({ where: { id: accountId } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
});

it("shares an assigned user's image with all assignees and admins without exposing binary data in account lists", async () => {
  expect((await app.inject({ url: imagePath(), headers: sessions[1] })).statusCode).toBe(404);
  const response = await upload(png(100).toString("base64"));
  expect(response.statusCode).toBe(200);
  const { imageUrl } = response.json();
  for (const headers of sessions.slice(0, 3)) {
    const image = await app.inject({ url: imageUrl, headers });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["cache-control"]).toBe("private, no-store");
    expect(PNG.sync.read(image.rawPayload).data[0]).toBe(100);
    const list = await app.inject({ url: "/api/minecraft/accounts", headers });
    const account = list.json().find((entry: { id: string }) => entry.id === accountId);
    expect(account.imageUrl).toBe(imageUrl);
    expect(account).not.toHaveProperty("image");
    expect(account).not.toHaveProperty("data");
  }
});

it("replaces the stored image atomically and changes its revision", async () => {
  const before = await prisma.accountImage.findUniqueOrThrow({ where: { minecraftAccountId: accountId } });
  const result = await upload(png(220).toString("base64"), 2);
  expect(result.statusCode).toBe(200);
  const after = await prisma.accountImage.findUniqueOrThrow({ where: { minecraftAccountId: accountId } });
  expect(after.revision).not.toBe(before.revision);
  expect(await prisma.accountImage.count({ where: { minecraftAccountId: accountId } })).toBe(1);
  expect(PNG.sync.read(Buffer.from(after.data)).data[0]).toBe(220);
});

it("protects image reads and uploads with account permissions, authentication and CSRF", async () => {
  expect((await app.inject({ url: imagePath() })).statusCode).toBe(401);
  expect((await app.inject({ method: "PUT", url: imagePath(), payload: { image: png(1).toString("base64") } })).statusCode).toBe(401);
  expect((await app.inject({ url: imagePath(), headers: sessions[3] })).statusCode).toBe(404);
  expect((await upload(png(1).toString("base64"), 3)).statusCode).toBe(404);
  expect((await app.inject({ method: "PUT", url: imagePath(), headers: { cookie: sessions[1].cookie }, payload: { image: png(1).toString("base64") } })).statusCode).toBe(403);
  expect((await app.inject({ method: "PUT", url: "/api/minecraft/accounts/missing/image", headers: sessions[0], payload: { image: png(1).toString("base64") } })).statusCode).toBe(404);
});

it("rejects invalid, oversized and corrupt uploads without replacing the current image", async () => {
  const before = await prisma.accountImage.findUniqueOrThrow({ where: { minecraftAccountId: accountId } });
  const huge = new PNG({ width: 257, height: 1 });
  const corrupt = png(10);
  corrupt[corrupt.length - 1] ^= 1;
  for (const invalid of ["", "not base64", Buffer.from("<svg></svg>").toString("base64"),
    PNG.sync.write(huge).toString("base64"), corrupt.toString("base64"), "A".repeat(MAX_ACCOUNT_IMAGE_BASE64 + 4)]) {
    expect((await upload(invalid)).statusCode).toBe(400);
  }
  const after = await prisma.accountImage.findUniqueOrThrow({ where: { minecraftAccountId: accountId } });
  expect(after.revision).toBe(before.revision);
  expect(after.data).toEqual(before.data);
});

it("broadcasts replacement images only to authorized dashboard viewers and honors revoked access", async () => {
  const port = (app.server.address() as AddressInfo).port;
  const sockets: WebSocket[] = [];
  const inboxes: { type: string; id?: string; imageUrl?: string }[][] = [];
  try {
    for (const headers of sessions) {
      const inbox: (typeof inboxes)[number] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`, { headers: { cookie: headers.cookie, origin: config.publicOrigin } });
      socket.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
      sockets.push(socket);
      inboxes.push(inbox);
      await once(socket, "open");
      await expect.poll(() => inbox.some((message) => message.type === "statuses")).toBe(true);
    }
    const result = await upload(png(150).toString("base64"), 0);
    for (const inbox of inboxes.slice(0, 3)) {
      await expect.poll(() => inbox.find((message) => message.type === "account_image")?.imageUrl).toBe(result.json().imageUrl);
    }
    expect(inboxes[3].some((message) => message.type === "account_image")).toBe(false);
    await prisma.userMinecraftAccount.delete({ where: { userId_minecraftAccountId: { userId: users[2], minecraftAccountId: accountId } } });
    expect((await app.inject({ url: imagePath(), headers: sessions[2] })).statusCode).toBe(404);
    expect((await upload(png(1).toString("base64"), 2)).statusCode).toBe(404);
    const replacement = await upload(png(180).toString("base64"), 0);
    await expect.poll(() => inboxes[1].some((message) => message.imageUrl === replacement.json().imageUrl)).toBe(true);
    expect(inboxes[2].some((message) => message.imageUrl === replacement.json().imageUrl)).toBe(false);
  } finally {
    await Promise.all(sockets.map(async (socket) => { const closed = once(socket, "close"); socket.close(); await closed; }));
  }
});

it("deletes the image with its Minecraft account", async () => {
  await prisma.minecraftAccount.delete({ where: { id: accountId } });
  expect(await prisma.accountImage.count({ where: { minecraftAccountId: accountId } })).toBe(0);
});
