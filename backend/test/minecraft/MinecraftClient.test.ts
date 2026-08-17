import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * Fake `azalea-bot` subprocess: an EventEmitter with the child-process surface
 * MinecraftClient uses (stdin.write, stdout/stderr streams, kill, exit). Tests
 * drive the real state machine by pushing NDJSON lines to stdout and emitting
 * `exit`, without spawning a real process or opening a network connection.
 */
class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), destroyed: false };
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  pid = 4242;
  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  });

  /** Emit one NDJSON event line on stdout, as the real bot would. */
  send(event: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(event) + "\n");
  }
}

const children: FakeChild[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }),
  };
});

// Pretend the compiled bot binary exists so findBotBinary() resolves a path.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(() => true) };
});

const { MinecraftClient } = await import("../../src/minecraft/MinecraftClient.js");
import type { ClientRuntimeConfig } from "../../src/minecraft/types.js";

/** Let readline process any pending stdout lines. */
const tick = () => new Promise((r) => setImmediate(r));

function baseConfig(overrides: Partial<ClientRuntimeConfig> = {}): ClientRuntimeConfig {
  return {
    id: "acc-1",
    name: "Bot_01",
    minecraftVersion: "",
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

const active: Array<{ disconnect: () => void }> = [];
function makeClient(overrides: Partial<ClientRuntimeConfig> = {}) {
  const client = new MinecraftClient(baseConfig(overrides));
  active.push(client);
  return client;
}
function lastChild(): FakeChild {
  return children[children.length - 1];
}

describe("MinecraftClient (Azalea subprocess) state machine", () => {
  beforeEach(() => {
    children.length = 0;
    active.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Tear down any clients so their reconnect/kill timers don't dangle.
    for (const c of active) c.disconnect();
  });

  it("starts OFFLINE, goes CONNECTING on connect, ONLINE on spawn", async () => {
    const client = makeClient();
    expect(client.getStatus().status).toBe("OFFLINE");

    client.connect();
    expect(client.getStatus().status).toBe("CONNECTING");
    expect(children).toHaveLength(1);

    lastChild().send({ type: "spawn" });
    await tick();
    expect(client.getStatus().status).toBe("ONLINE");
  });

  it("writes the config as the first line to the subprocess stdin", () => {
    const client = makeClient({ serverHost: "play.example.com", serverPort: 25566 });
    client.connect();

    const firstWrite = lastChild().stdin.write.mock.calls[0]?.[0] as string;
    const config = JSON.parse(firstWrite.trim());
    expect(config.host).toBe("play.example.com");
    expect(config.port).toBe(25566);
    expect(config.auth_type).toBe("offline");
  });

  it("goes OFFLINE on manual disconnect", () => {
    const client = makeClient();
    client.connect();
    client.disconnect();
    expect(client.getStatus().status).toBe("OFFLINE");
  });

  it("schedules a reconnect (RECONNECTING) after an unexpected exit", async () => {
    const client = makeClient({ autoReconnect: true });
    client.connect();
    lastChild().send({ type: "spawn" });
    await tick();
    expect(client.getStatus().status).toBe("ONLINE");

    lastChild().emit("exit", 1, null);
    expect(client.getStatus().status).toBe("RECONNECTING");
    expect(client.getStatus().lastError).toContain("code 1");
  });

  it("goes ERROR (no reconnect) on unexpected exit when autoReconnect is disabled", async () => {
    const client = makeClient({ autoReconnect: false });
    client.connect();
    lastChild().send({ type: "spawn" });
    await tick();

    lastChild().emit("exit", 1, null);
    expect(client.getStatus().status).toBe("ERROR");
  });

  it("schedules a reconnect after a connection_failed event", async () => {
    const client = makeClient({ autoReconnect: true });
    client.connect();

    lastChild().send({ type: "connection_failed", error: "Connection refused" });
    await tick();
    expect(client.getStatus().status).toBe("RECONNECTING");
    expect(client.getStatus().lastError).toContain("Connection refused");
  });

  it("sendCommand returns false and writes nothing while offline", () => {
    const client = makeClient();
    expect(client.sendCommand("gamemode creative")).toBe(false);
  });

  it("sendCommand forwards a chat command to the subprocess while online", async () => {
    const client = makeClient();
    client.connect();
    lastChild().send({ type: "spawn" });
    await tick();

    lastChild().stdin.write.mockClear();
    const result = client.sendCommand("/gamemode creative");
    expect(result).toBe(true);

    const written = lastChild().stdin.write.mock.calls[0][0] as string;
    expect(JSON.parse(written.trim())).toEqual({ type: "chat", text: "/gamemode creative" });
  });

  it("emits a CHAT console event for player chat and SERVER_MESSAGE for system chat", async () => {
    const client = makeClient();
    const events: string[] = [];
    client.on("console", (e: { type: string; message: string }) => events.push(`${e.type}:${e.message}`));

    client.connect();
    lastChild().send({ type: "spawn" });
    lastChild().send({ type: "chat", sender: "Steve", message: "hello there" });
    lastChild().send({ type: "chat", sender: null, message: "Server restarting" });
    await tick();

    expect(events).toContain("CHAT:<Steve> hello there");
    expect(events).toContain("SERVER_MESSAGE:Server restarting");
  });

  it("surfaces the Microsoft device code as a status prompt", async () => {
    const client = makeClient({ authType: "MICROSOFT", credentialsSecret: "bot@example.com" });
    client.connect();

    lastChild().send({
      type: "msa_code",
      verification_uri: "https://microsoft.com/link",
      user_code: "ABCD-EFGH",
      expires_in: 900,
    });
    await tick();

    const msa = client.getStatus().msaSignIn;
    expect(msa?.userCode).toBe("ABCD-EFGH");
    expect(msa?.verificationUri).toBe("https://microsoft.com/link");
  });

  it("emits a profile event so the account can be auto-named", async () => {
    const client = makeClient({ authType: "MICROSOFT", credentialsSecret: "bot@example.com" });
    const profiles: Array<{ username: string; uuid: string }> = [];
    client.on("profile", (p: { username: string; uuid: string }) => profiles.push(p));

    client.connect();
    lastChild().send({ type: "profile", username: "CoolBot", uuid: "uuid-123" });
    await tick();

    expect(profiles).toEqual([{ minecraftAccountId: "acc-1", username: "CoolBot", uuid: "uuid-123" }]);
  });

  it("emits status snapshots (not bare strings) on transitions", async () => {
    const client = makeClient();
    const statuses: string[] = [];
    client.on("status", (s: { status: string; id: string }) => statuses.push(s.status));

    client.connect();
    lastChild().send({ type: "spawn" });
    await tick();

    expect(statuses).toContain("CONNECTING");
    expect(statuses).toContain("ONLINE");
  });

  it("recycles a hung connection via the safety timeout", () => {
    vi.useFakeTimers();
    try {
      const client = makeClient({ autoReconnect: true });
      client.connect();
      expect(client.getStatus().status).toBe("CONNECTING");

      // Never send spawn/failure — simulate a fully hung subprocess — and
      // advance past the hang timeout.
      vi.advanceTimersByTime(5 * 60_000 + 1000);
      expect(client.getStatus().status).toBe("RECONNECTING");
    } finally {
      vi.useRealTimers();
    }
  });
});
