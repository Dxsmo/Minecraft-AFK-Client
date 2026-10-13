import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { buildApp } from "../../src/app.js";
import { prisma } from "../../src/database/prisma.js";
import { createSession } from "../../src/auth/session.js";
import { clientManager } from "../../src/minecraft/ClientManager.js";
import { config } from "../../src/config/config.js";
import type { ClientStatusSnapshot } from "../../src/minecraft/types.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let userId: string;
let cookie: string;
let emitStatus: (status: ClientStatusSnapshot) => void;
let emitConsole: Parameters<typeof clientManager.onConsoleEvent>[0];
const statuses: ClientStatusSnapshot[] = [];

beforeAll(async () => {
  const user = await prisma.user.create({ data: { username: `batch-${randomUUID()}`, passwordHash: "test" } });
  userId = user.id;
  const session = await createSession(user.id, {});
  cookie = `${config.session.cookieName}=${session.sessionId}`;
  for (let i = 0; i < 2; i++) {
    const account = await prisma.minecraftAccount.create({ data: {
      name: `Batch-${randomUUID()}`, serverHost: "localhost", assignments: { create: { userId } },
    } });
    statuses.push({ id: account.id, name: account.name, status: "ONLINE", serverHost: "localhost", serverPort: 25565 });
  }
  vi.spyOn(clientManager, "getAllStatuses").mockReturnValue(statuses);
  vi.spyOn(clientManager, "onStatusEvent").mockImplementation(listener => { emitStatus = listener; return () => {}; });
  vi.spyOn(clientManager, "onConsoleEvent").mockImplementation(listener => { emitConsole = listener; return () => {}; });
  app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
});

it("delivers every console line in a burst with one fresh session check", async () => {
  const port = (app.server.address() as AddressInfo).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/accounts/${statuses[0].id}`, { headers: { cookie, origin: config.publicOrigin } });
  const messages: any[] = [];
  socket.on("message", raw => messages.push(JSON.parse(raw.toString())));
  const sessions = vi.spyOn(prisma.session, "findUnique");
  try {
    await once(socket, "open");
    await expect.poll(() => messages.some(message => message.type === "history")).toBe(true);
    sessions.mockClear();
    for (let i = 0; i < 180; i++) emitConsole({ minecraftAccountId: statuses[0].id,
      type: "CHAT", message: `line ${i}`, timestamp: new Date().toISOString() });
    await expect.poll(() => messages.filter(message => message.type === "console").length).toBe(180);
    expect(messages.filter(message => message.type === "console").map(message => message.event.message))
      .toEqual(Array.from({ length: 180 }, (_, i) => `line ${i}`));
    expect(sessions).toHaveBeenCalledTimes(1);
  } finally {
    const closed = once(socket, "close"); socket.close(); await closed;
    sessions.mockRestore();
  }
});
afterAll(async () => {
  await app?.close();
  vi.restoreAllMocks();
  await prisma.minecraftAccount.deleteMany({ where: { id: { in: statuses.map(s => s.id) } } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

it("coalesces a burst into one current authorization check and excludes revoked accounts", async () => {
  const port = (app.server.address() as AddressInfo).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`, { headers: { cookie, origin: config.publicOrigin } });
  const messages: any[] = [];
  socket.on("message", raw => messages.push(JSON.parse(raw.toString())));
  const sessions = vi.spyOn(prisma.session, "findUnique");
  const assignments = vi.spyOn(prisma.userMinecraftAccount, "findMany");
  try {
    await once(socket, "open");
    await expect.poll(() => messages.some(m => m.type === "statuses")).toBe(true);
    expect(assignments).toHaveBeenCalledTimes(1);
    sessions.mockClear(); assignments.mockClear();
    await prisma.userMinecraftAccount.deleteMany({ where: { userId, minecraftAccountId: statuses[1].id } });
    for (let i = 0; i < 100; i++) for (const status of statuses) emitStatus({ ...status, name: `Update-${i}` });
    await expect.poll(() => messages.find(m => m.type === "status")?.status.name).toBe("Update-99");
    expect(messages.filter(m => m.type === "status")).toHaveLength(1);
    expect(messages.find(m => m.type === "status").status.id).toBe(statuses[0].id);
    expect(sessions).toHaveBeenCalledTimes(1);
    expect(assignments).toHaveBeenCalledTimes(1);
  } finally {
    const closed = once(socket, "close"); socket.close(); await closed;
    sessions.mockRestore(); assignments.mockRestore();
  }
});
