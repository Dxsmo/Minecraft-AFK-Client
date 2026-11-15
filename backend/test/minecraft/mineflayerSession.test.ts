import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import mc, { type Server, type ServerClient } from "minecraft-protocol";
import minecraftData from "minecraft-data";
import { startMineflayer, type MineflayerSession } from "../../src/mineflayer-bot/session.js";
import { MineflayerGateway } from "../../src/mineflayer-bot/gateway.js";
import { createBotProcess } from "../../src/minecraft/botProcess.js";
import readline from "node:readline";

const servers: Server[] = [], sessions: MineflayerSession[] = [], directories: string[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.stop();
  for (const server of servers.splice(0)) server.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(version = "1.16.5") {
  const data = minecraftData(version);
  const server = mc.createServer({ host: "127.0.0.1", port: 0, version, "online-mode": false, hideErrors: true });
  servers.push(server);
  const peers: ServerClient[] = [];
  server.on("playerJoin", client => {
    peers.push(client);
    client.write("login", { ...data.loginPacket, entityId: client.id });
    client.write("position", { x: 0, y: 64, z: 0, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0,
      flags: data.version.version >= 766 ? {} : 0, teleportId: 1, dismountVehicle: false });
    // Deliberately omit update_health: proxies may never send it.
  });
  await once(server, "listening");
  const cache = await mkdtemp(path.join(os.tmpdir(), "afk-mineflayer-test-"));
  directories.push(cache);
  const events: Record<string, unknown>[] = [];
  const ended = vi.fn();
  const session = startMineflayer({ host: "127.0.0.1", port: (server.socketServer.address() as AddressInfo).port,
    username: "LocalTest", auth_type: "offline", version, cache_dir: cache }, event => events.push(event), ended);
  sessions.push(session);
  await vi.waitFor(() => expect(events.some(event => event.type === "spawn")).toBe(true), { timeout: 5000 });
  return { server, peers, session, events, ended };
}

describe("Mineflayer local TCP integration", () => {
  it("starts an isolated account process and drains it on stop", async () => {
    const f = await fixture("26.1");
    const cache = await mkdtemp(path.join(os.tmpdir(), "afk-child-test-")); directories.push(cache);
    const child = createBotProcess("JAVA");
    const events: Record<string, unknown>[] = [];
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", line => { try { events.push(JSON.parse(line)); } catch { /* External diagnostic. */ } });
    const errors: Error[] = []; child.on("error", error => errors.push(error));
    child.stdin.write(JSON.stringify({ host: "127.0.0.1", port: (f.server.socketServer.address() as AddressInfo).port,
      username: "ChildTest", auth_type: "offline", version: "26.1", cache_dir: cache }) + "\n");
    try {
      await vi.waitFor(() => expect(events.some(event => event.type === "spawn")).toBe(true), { timeout: 7000 });
      expect(errors).toEqual([]);
      const closed = once(child, "close");
      child.stdin.write('{"type":"disconnect"}\n');
      await closed;
      expect(child.exitCode).toBe(0);
      expect(events.filter(event => event.type === "spawn")).toHaveLength(1);
    } finally { child.kill("SIGKILL"); lines.close(); }
  });

  it.each(["1.16.5", "26.1"])("enters %s without a health packet, sends commands and reports one disconnect", async version => {
    const f = await fixture(version);
    expect(f.events.some(event => event.type === "profile" && event.username === "LocalTest")).toBe(true);
    const received = once(f.peers[0], version === "1.16.5" ? "chat" : "chat_command");
    f.session.command({ type: "chat", text: "/home" });
    const packet = (await received)[0];
    expect(packet.message ?? `/${packet.command}`).toBe("/home");
    f.peers[0].end("Local test kick");
    await vi.waitFor(() => expect(f.ended).toHaveBeenCalledTimes(1));
    expect(f.events.filter(event => event.type === "disconnect")).toHaveLength(1);
    f.session.stop();
    expect(f.ended).toHaveBeenCalledTimes(1);
  });

  it("keeps sneak asserted during checks and disposes the connection exactly once", async () => {
    const f = await fixture();
    const gateway = new MineflayerGateway(f.session.bot);
    const actions: unknown[] = [];
    f.peers[0].on("entity_action", packet => actions.push(packet.actionId));
    await gateway.held({ crouch_enabled: true });
    await gateway.sneak(); await gateway.sneak();
    await vi.waitFor(() => expect(actions.length).toBeGreaterThanOrEqual(3));
    expect(actions).toEqual(["start_sneaking", "start_sneaking", "start_sneaking"]);
    f.session.stop(); f.session.stop();
    expect(f.ended).toHaveBeenCalledTimes(1);
  });
});
