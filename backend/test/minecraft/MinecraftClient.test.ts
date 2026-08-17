import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * Fake Mineflayer bot: a bare EventEmitter with the handful of methods
 * MinecraftClient actually calls. Lets tests drive the real state machine
 * by emitting 'spawn' / 'end' / 'error' / 'chat' / 'message' without ever
 * opening a real network connection.
 */
class FakeBot extends EventEmitter {
  username = "TestBot";
  health = 20;
  food = 20;
  entity = { position: { x: 0, y: 64, z: 0 } };
  chat = vi.fn();
  quit = vi.fn(() => this.emit("end", "quit() called"));
  setControlState = vi.fn();
  look = vi.fn();
}

const createdBots: FakeBot[] = [];

vi.mock("mineflayer", () => ({
  default: {
    createBot: vi.fn(() => {
      const bot = new FakeBot();
      createdBots.push(bot);
      return bot;
    }),
  },
}));

const { MinecraftClient } = await import("../../src/minecraft/MinecraftClient.js");
import type { ClientRuntimeConfig } from "../../src/minecraft/types.js";

function baseConfig(overrides: Partial<ClientRuntimeConfig> = {}): ClientRuntimeConfig {
  return {
    id: "acc-1",
    name: "Bot_01",
    minecraftVersion: "1.20.4",
    serverHost: "localhost",
    serverPort: 25565,
    authType: "OFFLINE",
    credentialsSecret: null,
    afkEnabled: false,
    movementEnabled: false,
    afkIntervalSeconds: 30,
    autoReconnect: true,
    ...overrides,
  };
}

describe("MinecraftClient state machine", () => {
  beforeEach(() => {
    createdBots.length = 0;
    vi.clearAllMocks();
  });

  it("starts OFFLINE and moves to CONNECTING then ONLINE on spawn", () => {
    const client = new MinecraftClient(baseConfig());
    expect(client.getStatus().status).toBe("OFFLINE");

    client.connect();
    expect(client.getStatus().status).toBe("CONNECTING");

    createdBots[0].emit("spawn");
    expect(client.getStatus().status).toBe("ONLINE");
  });

  it("goes OFFLINE on manual disconnect and does not auto-reconnect", () => {
    const client = new MinecraftClient(baseConfig());
    client.connect();
    createdBots[0].emit("spawn");
    expect(client.getStatus().status).toBe("ONLINE");

    client.disconnect();
    expect(client.getStatus().status).toBe("OFFLINE");
    expect(createdBots[0].quit).toHaveBeenCalled();
  });

  it("schedules a reconnect (RECONNECTING) after an unexpected disconnect", () => {
    const client = new MinecraftClient(baseConfig({ autoReconnect: true }));
    client.connect();
    createdBots[0].emit("spawn");

    createdBots[0].emit("end", "connection reset");
    expect(client.getStatus().status).toBe("RECONNECTING");
    expect(client.getStatus().reconnectAttempt).toBe(1);
  });

  it("goes OFFLINE (no reconnect) after unexpected disconnect when autoReconnect is disabled", () => {
    const client = new MinecraftClient(baseConfig({ autoReconnect: false }));
    client.connect();
    createdBots[0].emit("spawn");

    createdBots[0].emit("end", "connection reset");
    expect(client.getStatus().status).toBe("OFFLINE");
  });

  it("sendCommand returns false and does not call bot.chat while offline", () => {
    const client = new MinecraftClient(baseConfig());
    expect(client.sendCommand("gamemode creative")).toBe(false);
  });

  it("sendCommand prefixes with '/' and forwards to bot.chat while online", () => {
    const client = new MinecraftClient(baseConfig());
    client.connect();
    createdBots[0].emit("spawn");

    const result = client.sendCommand("gamemode creative");
    expect(result).toBe(true);
    expect(createdBots[0].chat).toHaveBeenCalledWith("/gamemode creative");
  });

  it("emits CHAT console events for other players and ignores the bot's own username", () => {
    const client = new MinecraftClient(baseConfig());
    const events: string[] = [];
    client.on("console", (e: { type: string; message: string }) => events.push(`${e.type}:${e.message}`));

    client.connect();
    createdBots[0].emit("spawn");
    createdBots[0].emit("chat", "Steve", "hello there");
    createdBots[0].emit("chat", "TestBot", "should be ignored");

    expect(events).toContain("CHAT:Steve: hello there");
    expect(events.some((e) => e.includes("should be ignored"))).toBe(false);
  });
});
