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
  acceptResourcePack = vi.fn();
  _client = new EventEmitter();
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
    credentialsPassword: null,
    afkEnabled: false,
    movementEnabled: false,
    afkIntervalSeconds: 30,
    autoReconnect: true,
    autoCommandEnabled: false,
    autoCommandText: "",
    autoCommandIntervalMinutes: 5,
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

  it("auto-accepts a server resource pack instead of leaving the join blocked", () => {
    const client = new MinecraftClient(baseConfig());
    client.connect();
    createdBots[0].emit("resourcePack", "https://example.com/pack.zip");

    expect(createdBots[0].acceptResourcePack).toHaveBeenCalled();
  });

  it("forces a reconnect if the connection is stuck without any server activity (watchdog)", () => {
    vi.useFakeTimers();
    try {
      const client = new MinecraftClient(baseConfig({ autoReconnect: true }));
      client.connect();
      expect(client.getStatus().status).toBe("CONNECTING");

      // Never emit 'spawn'/'forcedMove' or any packet activity — simulate a
      // fully hung connection — and advance past the inactivity timeout.
      vi.advanceTimersByTime(95_000);

      expect(client.getStatus().status).toBe("RECONNECTING");
      expect(createdBots[0].quit).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not give up while the server keeps sending packets, even past the old fixed timeout", () => {
    vi.useFakeTimers();
    try {
      const client = new MinecraftClient(baseConfig({ autoReconnect: true }));
      client.connect();

      // Simulate a server that is slow (e.g. an anti-bot verification queue)
      // but still exchanging packets with us every 20s, well past what used
      // to be a fixed 45s giveup — this should NOT trigger a reconnect.
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersByTime(20_000);
        createdBots[0]._client.emit("packet", {});
      }

      expect(client.getStatus().status).toBe("CONNECTING");
      expect(createdBots[0].quit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats 'forcedMove' (position sync) as sufficient to go ONLINE even without 'spawn'", () => {
    const client = new MinecraftClient(baseConfig());
    client.connect();
    expect(client.getStatus().status).toBe("CONNECTING");

    // Some servers never send an update_health packet (which normally
    // drives mineflayer's 'spawn' event), even though the player has
    // actually joined — 'forcedMove' should be enough on its own.
    createdBots[0].emit("forcedMove");
    expect(client.getStatus().status).toBe("ONLINE");
  });
});
