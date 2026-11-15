import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createBotProcess } from "../../src/minecraft/botProcess.js";

it("isolates a real Bedrock UDP transport rejection and retains its native reason", async () => {
  const { Server } = createRequire(import.meta.url)("bedrock-protocol");
  const probe = createSocket("udp4");
  probe.bind(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; probe.close(); await once(probe, "close");
  // Deliberately incompatible: the fixture supports RakNet 10 while the
  // modern production client uses RakNet 11. This is a transport-failure test,
  // not a successful game login; modern menus use real codec tests separately.
  const server = new Server({ host: "127.0.0.1", port, version: "1.26.51", offline: true, raknetBackend: "jsp-raknet" });
  const errors: unknown[] = [];
  server.on("error", (error: unknown) => errors.push(error));
  await server.listen();
  const cache = await mkdtemp(path.join(os.tmpdir(), "afk-bedrock-test-"));
  const child = createBotProcess("BEDROCK");
  const events: Record<string, unknown>[] = [];
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => { try { events.push(JSON.parse(line)); } catch { /* External diagnostics. */ } });
  child.on("error", error => errors.push(error));
  const closed = once(child, "close");
  try {
    child.stdin.write(JSON.stringify({ host: "127.0.0.1", port, username: "LocalBedrock", auth_type: "offline",
      version: "1.26.51", cache_dir: cache }) + "\n");
    await vi.waitFor(() => expect(events.some(event => event.type === "disconnect" || event.type === "fatal_error" || event.type === "connection_failed"))
      .toBe(true), { timeout: 8000 });
    expect(events, JSON.stringify({ events, errors })).toContainEqual(expect.objectContaining({ type: "disconnect", reason: "RakNet transport closed (reason 25)" }));
    await closed;
    expect(events.some(event => event.type === "profile" && event.username === "LocalBedrock")).toBe(true);
    expect(events.some(event => event.type === "spawn")).toBe(false);
    expect(events.filter(event => event.type === "disconnect")).toHaveLength(1);
    expect(events.some(event => event.type === "fatal_error" || event.type === "connection_failed")).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
    lines.close(); await server.close(); await rm(cache, { recursive: true, force: true });
  }
}, 12000);
