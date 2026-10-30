import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

/**
 * Fake SoulFire adapter subprocess: an EventEmitter with the child-process surface
 * MinecraftClient uses (stdin.write, stdout/stderr streams, kill, exit). Tests
 * drive the real state machine by pushing NDJSON lines to stdout and emitting
 * `exit`, without spawning a real process or opening a network connection.
 */
class FakeChild extends EventEmitter {
  stdin = Object.assign(new Writable({
    write(_chunk, _encoding, callback) { callback(); },
  }), { write: vi.fn<Writable["write"]>() });
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 4242;
  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    this.signalCode = signal ?? "SIGTERM";
    this.emit("exit", null, signal ?? "SIGTERM");
    this.emit("close", null, signal ?? "SIGTERM");
    return true;
  });

  /** Emit one NDJSON event line on stdout, as the real bot would. */
  send(event: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(event) + "\n");
  }

  /** Simulate the process ending on its own (crash / connection dropped). */
  exitWith(code: number | null): void {
    this.exitCode = code;
    this.stdout.end();
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

const children: FakeChild[] = [];

vi.mock("../../src/soulfire/controller.js", () => ({
  createSoulFireController: vi.fn(() => {
    const child = new FakeChild(); children.push(child); return child;
  }),
}));

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
    autoReconnect: true,
    edition: "JAVA",
    crouchEnabled: false,
    autoButton: "OFF",
    autoSellEnabled: false,
    autoSellIntervalSeconds: 60,
    autoSellCommand: "/sell",
    spawnerType: "",
    spawnerDropItems: [],
    spawnerSellItems: [],
    ...overrides,
  };
}

const active: Array<{ disconnect: () => void; dispose: () => void }> = [];
function makeClient(overrides: Partial<ClientRuntimeConfig> = {}) {
  const client = new MinecraftClient(baseConfig(overrides));
  active.push(client);
  return client;
}
function lastChild(): FakeChild {
  return children[children.length - 1];
}

describe("MinecraftClient (SoulFire adapter) state machine", () => {
  beforeEach(() => {
    children.length = 0;
    active.length = 0;
    vi.clearAllMocks();
    vi.stubEnv("JAVA_STANDARD_NETWORK_ACCOUNTS", "");
  });

  afterEach(() => {
    // Tear down any clients so their reconnect/kill timers don't dangle.
    for (const c of active) c.dispose();
    vi.unstubAllEnvs();
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

  it("does not collect or broadcast removed health, food and reconnect counters", async () => {
    const client = makeClient();
    client.connect();
    lastChild().send({ type: "spawn" });
    await tick();
    const status = vi.fn();
    client.on("status", status);
    lastChild().send({ type: "health", health: 3, food: 2 });
    await tick();
    expect(status).not.toHaveBeenCalled();
    for (const field of ["health", "food", "reconnectAttempt"]) expect(client.getStatus()).not.toHaveProperty(field);
  });

  it.each(["JAVA", "BEDROCK"] as const)("passes persistent mouse input to %s on initial connection, live changes and reconnect", async edition => {
    const client = makeClient({ edition, autoButton: "RIGHT" });
    client.connect();
    const messages = (child: FakeChild) => child.stdin.write.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(messages(lastChild())[0]).toMatchObject({ auto_button: "right" });
    lastChild().send({ type: "spawn" }); await tick();
    client.updateConfig(baseConfig({ edition, autoButton: "LEFT" }));
    expect(messages(lastChild()).at(-1)).toMatchObject({ type: "configure", auto_button: "left" });
    client.disconnect(); client.connect();
    expect(messages(lastChild())[0]).toMatchObject({ auto_button: "left" });
  });

  it.each(["JAVA", "BEDROCK"] as const)("checks enabled %s crouch every 30 minutes independently of repeat spawns", async edition => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const client = makeClient({ edition, crouchEnabled: true });
    try {
      client.connect();
      const child = lastChild();
      child.send({ type: "spawn" });
      await tick();
      heartbeat = setInterval(() => child.send({ type: "heartbeat" }), 30_000);
      const checks = () => child.stdin.write.mock.calls.map(([line]) => JSON.parse(String(line)))
        .filter(message => message.type === "check_crouch");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      child.send({ type: "spawn" });
      await tick();
      await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
      expect(checks()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(checks()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(checks()).toHaveLength(2);
      client.updateConfig(baseConfig({ edition, crouchEnabled: false }));
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(checks()).toHaveLength(2);
      client.updateConfig(baseConfig({ edition, crouchEnabled: true }));
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(checks()).toHaveLength(3);
      client.disconnect();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(checks()).toHaveLength(3);
    } finally {
      clearInterval(heartbeat);
      client.dispose();
      vi.useRealTimers();
    }
  });

  it("rejects plain chat and multiple lines before writing to the bot", async () => {
    const client = makeClient();
    client.connect();
    lastChild().send({ type: "spawn" });
    await tick();
    const child = lastChild();
    child.stdin.write.mockClear();
    for (const text of ["hello", "/", " /home", "/say hi\nplain chat", "/\u0000"]) {
      expect(client.sendCommand(text)).toBe(false);
    }
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(client.sendCommand("/home farm")).toBe(true);
    expect(client.sendCommand("//wand")).toBe(true);
    expect(child.stdin.write).toHaveBeenCalledTimes(2);
  });

  it.each(["JAVA", "BEDROCK"] as const)("retains the %s half-hour cadence across reconnects and catches a missed check on rejoin", async edition => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const client = makeClient({ edition, crouchEnabled: true });
    try {
      client.connect();
      lastChild().send({ type: "spawn" });
      await tick();
      heartbeat = setInterval(() => {
        if (client.getStatus().status === "ONLINE") lastChild().send({ type: "heartbeat" });
      }, 30_000);
      const checks = () => children.flatMap(child => child.stdin.write.mock.calls)
        .map(([line]) => JSON.parse(String(line))).filter(message => message.type === "check_crouch");
      await vi.advanceTimersByTimeAsync(30 * 60_000 - 1000);
      lastChild().exitWith(1);
      await tick();
      await vi.advanceTimersByTimeAsync(1000);
      expect(checks()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(14_000);
      expect(children).toHaveLength(2);
      lastChild().send({ type: "spawn" });
      await tick();
      expect(checks()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(30 * 60_000 - 14_000);
      expect(checks()).toHaveLength(2);
      client.disconnect();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(checks()).toHaveLength(2);
    } finally {
      clearInterval(heartbeat);
      client.dispose();
      vi.useRealTimers();
    }
  });

  it("writes the config as the first line to the subprocess stdin", () => {
    const client = makeClient({ serverHost: "play.example.com", serverPort: 25566 });
    client.connect();

    const firstWrite = lastChild().stdin.write.mock.calls[0]?.[0] as string;
    const config = JSON.parse(firstWrite.trim());
    expect(config.host).toBe("play.example.com");
    expect(config.port).toBe(25566);
    expect(config.auth_type).toBe("offline");
    expect(config.edition).toBe("JAVA");
    expect(config).not.toHaveProperty("auto_command_enabled");
    expect(config).not.toHaveProperty("tpauto_enabled");
  });

  it.each(["JAVA", "BEDROCK"] as const)("launches %s through the common SoulFire adapter", edition => {
    const client = makeClient({ edition });
    client.connect();
    const cfg = JSON.parse(String(lastChild().stdin.write.mock.calls[0][0]));
    expect(cfg).toMatchObject({ edition, account_id: "acc-1" });
    expect(cfg).not.toHaveProperty("java_network_mode");
  });

  it.each(["JAVA", "BEDROCK"] as const)("keeps %s offline for five seconds on restart and force-kills a stuck old process", edition => {
    vi.useFakeTimers();
    try {
      const client = makeClient({ edition });
      client.connect();
      const old = lastChild();
      old.kill.mockImplementation(signal => {
        old.killed = true;
        if (signal === "SIGKILL") {
          old.signalCode = signal;
          old.emit("exit", null, signal);
          old.emit("close", null, signal);
        }
        return true;
      });
      client.restart();
      expect(client.getStatus().status).toBe("OFFLINE");
      expect(children).toHaveLength(1);
      client.connect();
      vi.advanceTimersByTime(1999);
      expect(children).toHaveLength(1);
      vi.advanceTimersByTime(3000);
      expect(children).toHaveLength(1);
      vi.advanceTimersByTime(1);
      const replacement = lastChild();
      expect(replacement).not.toBe(old);
      expect(old.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(replacement.kill).not.toHaveBeenCalled();
      expect(client.getStatus().status).toBe("CONNECTING");
      client.dispose();
      vi.advanceTimersByTime(2000);
    } finally { vi.useRealTimers(); }
  });

  it("resets the restart wait on another restart and cancels it on stop or disposal", () => {
    vi.useFakeTimers();
    try {
      const client = makeClient();
      client.connect();
      client.restart();
      vi.advanceTimersByTime(2500);
      client.restart();
      vi.advanceTimersByTime(2500);
      expect(children).toHaveLength(1);
      client.disconnect();
      vi.advanceTimersByTime(5000);
      expect(children).toHaveLength(1);
      client.connect();
      expect(children).toHaveLength(2);
      client.restart();
      client.dispose();
      vi.advanceTimersByTime(5000);
      expect(children).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });


  it("never automatically queries /homes on joins or /sethome", async () => {
    const client = makeClient();
    client.connect();
    lastChild().send({ type: "spawn" });
    await tick();
    client.sendCommand("/sethome farm");
    lastChild().send({ type: "spawn" });
    await tick();
    const commands = lastChild().stdin.write.mock.calls.map(([line]) => JSON.parse(line));
    expect(commands.filter((cmd) => cmd.type === "chat").map((cmd) => cmd.text)).toEqual(["/sethome farm"]);
    expect(client.getStatus()).not.toHaveProperty("homes");
  });

  it.each(["JAVA", "BEDROCK"] as const)("retains the restart sell pause across %s reconnects", async (edition) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const client = makeClient({ edition, autoSellEnabled: true });
      client.connect();
      const first = lastChild();
      first.send({ type: "spawn" });
      first.send({ type: "chat", sender: null, message: "§cDie Welt wird in 30 Sekunden neu gestartet!" });
      await tick();
      const commands = first.stdin.write.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(commands.find((cmd) => cmd.type === "pause_autosell")).toEqual({
        type: "pause_autosell", autosell_pause_after_ms: 20_000, autosell_resume_after_ms: 150_000,
      });
      // A later countdown refers to the same restart rather than restarting two minutes from now.
      vi.advanceTimersByTime(25_000);
      first.send({ type: "chat", sender: null, message: "Die Welt wird in 5 Sekunden neu gestartet!" });
      await tick();
      expect(JSON.parse(String(first.stdin.write.mock.calls.at(-1)![0]))).toEqual({
        type: "pause_autosell", autosell_pause_after_ms: 0, autosell_resume_after_ms: 125_000,
      });
      first.exitWith(1);
      await tick();
      vi.advanceTimersByTime(15_000);
      const replacement = lastChild();
      expect(replacement).not.toBe(first);
      const config = JSON.parse(String(replacement.stdin.write.mock.calls[0][0]));
      expect(config.autosell_pause_after_ms).toBe(0);
      expect(config.autosell_resume_after_ms).toBe(110_000);
      replacement.send({ type: "spawn" });
      await tick();
      client.updateConfig(baseConfig({ edition, autoSellEnabled: true, autoSellIntervalSeconds: 5 }));
      expect(JSON.parse(String(replacement.stdin.write.mock.calls.at(-1)![0]))).toMatchObject({
        type: "configure", autosell_enabled: true, autosell_interval_seconds: 5,
      });
      vi.advanceTimersByTime(110_000);
      client.restart();
      expect(client.getStatus().status).toBe("OFFLINE");
      vi.advanceTimersByTime(5000);
      const expiredConfig = JSON.parse(String(lastChild().stdin.write.mock.calls[0][0]));
      expect(expiredConfig.autosell_resume_after_ms).toBe(0);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores player chat that looks like a world restart announcement", async () => {
    const client = makeClient();
    client.connect();
    lastChild().send({ type: "spawn" });
    lastChild().send({ type: "chat", sender: "Steve", message: "Die Welt wird in 10 Sekunden neu gestartet!" });
    await tick();
    const commands = lastChild().stdin.write.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(commands.some((cmd) => cmd.type === "pause_autosell")).toBe(false);
  });

  it("recognizes HugoSMP world restart announcements in named chat", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const client = makeClient();
      client.connect();
      const child = lastChild();
      child.send({ type: "spawn" });
      child.send({
        type: "chat", sender: "§6HugoSMP",
        message: "Diese Welt wird in 60 Sekunden neugestartet. Droppe am besten keine Items mehr!",
      });
      await tick();
      const commands = child.stdin.write.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(commands.find((cmd) => cmd.type === "pause_autosell")).toEqual({
        type: "pause_autosell", autosell_pause_after_ms: 50_000, autosell_resume_after_ms: 180_000,
      });
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects a bot without tick heartbeats even when chat, health and output still arrive", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const client = makeClient();
      client.connect();
      const stuck = lastChild();
      stuck.send({ type: "spawn" });
      const other = makeClient({ id: "acc-2" });
      other.connect();
      const healthy = lastChild();
      healthy.send({ type: "spawn" });
      await tick();
      for (let i = 0; i < 6; i++) {
        stuck.send({ type: "chat", sender: "HugoSMP", message: "Server message" });
        stuck.send({ type: "health", health: 20, food: 20 });
        stuck.stdout.write("not JSON\n");
        healthy.send({ type: "heartbeat" });
        await tick();
        vi.advanceTimersByTime(10_000);
      }
      expect(client.getStatus().status).toBe("RECONNECTING");
      expect(client.getStatus().lastError).toBe("Bot froze (no heartbeat)");
      expect(other.getStatus().status).toBe("ONLINE");
      client.dispose();
      other.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a quiet bot connected while its behavior ticks remain alive", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const client = makeClient();
      client.connect();
      const child = lastChild();
      child.send({ type: "spawn" });
      await tick();
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(20_000);
        child.send({ type: "heartbeat" });
        await tick();
      }
      expect(client.getStatus().status).toBe("ONLINE");
      expect(children).toHaveLength(1);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["JAVA", "BEDROCK"] as const)("sends no automatic commands on %s joins or reconnects with legacy home settings", async (edition) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const client = makeClient({
        edition,
        ...{
          homes: ["farm"],
          autoCommandEnabled: true,
          autoCommandText: "/homes",
          autoCommandIntervalMinutes: 5,
          dailyCommandEnabled: true,
          dailyCommandTimes: ["00:00"],
        },
      });
      client.connect();
      for (let join = 0; join < 2; join++) {
        const child = lastChild();
        child.send({ type: "login" });
        child.send({ type: "spawn" });
        await tick();
        // Exercise the real scheduling interval and delayed join callbacks.
        // Heartbeats keep the unrelated online watchdog from recycling the bot.
        for (let interval = 0; interval < 12; interval++) {
          child.send({ type: "heartbeat" });
          await tick();
          vi.advanceTimersByTime(30_000);
        }
        const messages = child.stdin.write.mock.calls.map(([line]) => JSON.parse(line));
        expect(messages.filter((message) => message.type === "chat" || message.type === "run_task")).toEqual([]);
        expect(messages[0]).not.toHaveProperty("auto_command_text");
        if (join === 0) {
          child.exitWith(1);
          await tick();
          vi.advanceTimersByTime(32_000);
          expect(children).toHaveLength(2);
        }
      }
    } finally {
      for (const client of active) client.dispose();
      vi.useRealTimers();
    }
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

    lastChild().exitWith(1);
    await tick();
    expect(client.getStatus().status).toBe("RECONNECTING");
    expect(client.getStatus().lastError).toContain("code 1");
  });

  it("reconnects at exactly 15 seconds on every attempt, without jitter", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const client = makeClient(); client.connect();
      for (let attempt = 0; attempt < 3; attempt++) {
        const failed = lastChild(); failed.exitWith(1); await tick();
        vi.advanceTimersByTime(14_999);
        expect(lastChild()).toBe(failed);
        vi.advanceTimersByTime(1);
        expect(lastChild()).not.toBe(failed);
      }
    } finally { for (const client of active) client.dispose(); vi.useRealTimers(); }
  });

  it.each(["JAVA", "BEDROCK"] as const)("checks enabled %s crouch at each of the next five minutes without duplicating the countdown", async edition => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const client = makeClient({ edition, crouchEnabled: true }); client.connect();
      const child = lastChild(); child.send({ type: "spawn" });
      child.send({ type: "chat", sender: "HugoSMP", message: "Diese Welt wird in 10 Sekunden neugestartet. Droppe am besten keine Items mehr!" });
      await tick();
      vi.advanceTimersByTime(5000);
      child.send({ type: "chat", sender: "HugoSMP", message: "Die Welt wird in 5 Sekunden neugestartet!" });
      await tick();
      for (let minute = 1; minute <= 6; minute++) {
        for (let step = 0; step < 3; step++) {
          child.send({ type: "heartbeat" }); await tick(); vi.advanceTimersByTime(20_000);
        }
        const checks = child.stdin.write.mock.calls.map(([line]) => JSON.parse(String(line))).filter(command => command.type === "check_crouch");
        expect(checks).toHaveLength(Math.min(minute, 5));
      }
    } finally { for (const client of active) client.dispose(); vi.useRealTimers(); }
  });

  it("performs a missed restart crouch check on rejoin within the five-minute window", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const client = makeClient({ crouchEnabled: true }); client.connect();
      const first = lastChild(); first.send({ type: "spawn" });
      first.send({ type: "chat", sender: null, message: "Diese Welt wird in 10 Sekunden neugestartet." }); await tick();
      // Keep the first process alive until just before the first scheduled check.
      for (let step = 0; step < 2; step++) { first.send({ type: "heartbeat" }); await tick(); vi.advanceTimersByTime(20_000); }
      vi.advanceTimersByTime(15_000); first.exitWith(1); await tick();
      vi.advanceTimersByTime(15_000);
      const replacement = lastChild(); replacement.send({ type: "spawn" }); await tick();
      expect(replacement.stdin.write.mock.calls.map(([line]) => JSON.parse(String(line))).filter(command => command.type === "check_crouch")).toHaveLength(1);
    } finally { for (const client of active) client.dispose(); vi.useRealTimers(); }
  });

  it("goes ERROR (no reconnect) on unexpected exit when autoReconnect is disabled", async () => {
    const client = makeClient({ autoReconnect: false });
    client.connect();
    lastChild().send({ type: "spawn" });
    await tick();

    lastChild().exitWith(1);
    await tick();
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

  it("handles asynchronous EPIPE from the disconnect write without losing the connection failure reason", async () => {
    const client = makeClient();
    client.connect();
    const child = lastChild();
    child.stdin._write = (_chunk, _encoding, callback) => {
      queueMicrotask(() => callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
    };
    child.stdin.write.mockImplementation(Writable.prototype.write.bind(child.stdin));

    child.send({ type: "connection_failed", error: "Connection refused" });
    await tick();

    expect(child.stdin.destroyed).toBe(true);
    expect(client.getStatus().status).toBe("RECONNECTING");
    expect(client.getStatus().lastError).toBe("Connection refused");
  });

  it("handles EPIPE during a live command and reconnects only the affected account", async () => {
    const client = makeClient();
    const other = makeClient({ id: "acc-2" });
    client.connect();
    const child = lastChild();
    child.send({ type: "spawn" });
    other.connect();
    lastChild().send({ type: "spawn" });
    await tick();
    child.stdin._write = (_chunk, _encoding, callback) => {
      queueMicrotask(() => callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
    };
    child.stdin.write.mockImplementation(Writable.prototype.write.bind(child.stdin));

    client.sendCommand("/home");
    await tick();

    expect(client.getStatus().status).toBe("RECONNECTING");
    expect(client.getStatus().lastError).toContain("EPIPE");
    expect(other.getStatus().status).toBe("ONLINE");
  });

  it("keeps late errors from a replaced subprocess from disconnecting the new process", () => {
    const client = makeClient();
    client.connect();
    const oldChild = lastChild();
    client.restart();
    expect(() => oldChild.stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
    expect(client.getStatus().status).toBe("OFFLINE");
    expect(client.getStatus().lastError).toBeUndefined();
  });

  it("handles a late pipe error after manual disconnect without reconnecting", () => {
    const client = makeClient();
    client.connect();
    const child = lastChild();
    client.disconnect();
    expect(() => child.stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
    expect(client.getStatus().status).toBe("OFFLINE");
  });

  it("does not send commands or disconnect messages to an ended input stream", async () => {
    const client = makeClient();
    client.connect();
    const child = lastChild();
    child.send({ type: "spawn" });
    await tick();
    child.stdin.end();
    child.stdin.write.mockClear();
    expect(client.sendCommand("/home")).toBe(false);
    client.disconnect();
    expect(child.stdin.write).not.toHaveBeenCalled();
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

  it.each(["/afk", "/AFK", "/afk on", "/essentials:afk", "/minecraft:AFK test"])("blocks %s locally without sending a game command", async command => {
    const client = makeClient(), events: any[] = []; client.on("console", event => events.push(event));
    client.connect(); lastChild().send({ type: "spawn" }); await tick();
    lastChild().stdin.write.mockClear(); events.length = 0;
    expect(client.sendCommand(command)).toBe(true);
    expect(lastChild().stdin.write).not.toHaveBeenCalled();
    expect(events).toHaveLength(1); expect(events[0].message).toContain("Stars zu farmen");
  });

  it("intercepts only exact /desmo and prints all nine results without sending them to Minecraft", async () => {
    const client = makeClient();
    const events: any[] = [];
    client.on("console", event => events.push(event));
    client.connect(); lastChild().send({ type: "spawn" }); await tick();
    const child = lastChild(); child.stdin.write.mockClear();
    expect(client.sendCommand("/desmo")).toBe(true);
    expect(JSON.parse(String(child.stdin.write.mock.calls[0][0]))).toEqual({ type: "read_sell_multipliers" });
    for (const command of ["/sellmulti", "/DESMO", "/desmo extra", "/desmo/"]) {
      expect(client.sendCommand(command)).toBe(true);
      expect(JSON.parse(String(child.stdin.write.mock.calls.at(-1)![0]))).toEqual({ type: "chat", text: command });
    }
    child.stdin.write.mockClear(); events.length = 0;
    const entries = Array.from({ length: 9 }, (_, index) => index === 1
      ? { name: 'Landwirtschaft', multiplier: '1.6x', progress: '26,28M$/150M$ - 17%' }
      : { name: `Kategorie ${index}`, multiplier: `${index + 1}x`, progress: '600$/800$ - 67%' });
    child.send({ type: "sell_multipliers", entries });
    await tick();
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('SYSTEM');
    expect(events[0].message).toBe('Desmo: Verkaufsmultiplikatoren (9 Kategorien)\n\n' + entries.map(entry =>
      `${entry.name}\n  Aktueller Multiplikator: ${entry.multiplier}\n  Fortschritt: ${entry.progress}`).join('\n\n'));
    expect(events[0].message).toContain('\n\nLandwirtschaft\n  Aktueller Multiplikator: 1.6x\n  Fortschritt: 26,28M$/150M$ - 17%\n\n');
    events.length = 0;
    child.send({ type: "sell_multipliers", entries: [{ name: "Fische", multiplier: "1x" }] }); await tick();
    expect(events).toHaveLength(1); expect(events[0].type).toBe("WARNING");
  });

  it("reports failed command pipes and does not log an unsent user command", async () => {
    const client = makeClient();
    const events: { type: string }[] = [];
    client.on("console", (event) => events.push(event));
    client.connect();
    lastChild().send({ type: "spawn" });
    await tick();
    lastChild().stdin.write.mockClear();
    lastChild().stdin.destroyed = true;
    expect(client.sendCommand("/home")).toBe(false);
    expect(lastChild().stdin.write).not.toHaveBeenCalled();
    lastChild().stdin.destroyed = false;
    lastChild().stdin.write.mockImplementation(() => { throw new Error("broken pipe"); });
    expect(client.sendCommand("/tpahere Steve")).toBe(false);
    expect(events.some((event) => event.type === "USER_COMMAND")).toBe(false);
  });

  it("accepts queued pipe backpressure", async () => {
    const client = makeClient();
    client.connect();
    lastChild().send({ type: "spawn" });
    await tick();
    lastChild().stdin.write.mockClear();
    lastChild().stdin.write.mockReturnValue(false);
    expect(client.sendCommand("/home")).toBe(true);
    expect(lastChild().stdin.write.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { type: "chat", text: "/home" },
    ]);
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

  it.each([null, "§6HugoSMP"])("reconnects after a server fallback from %s despite continuing heartbeats", sender => {
    vi.useFakeTimers();
    try {
      const client = makeClient();
      const consoleEvents: string[] = [];
      client.on("console", (event) => consoleEvents.push(event.message));
      client.connect();
      const old = lastChild();
      old.send({ type: "spawn" });
      old.send({ type: "heartbeat" });
      const message = "Verbindung zum vorherigen Server verloren – du wurdest auf einen anderen Server verschoben.";
      old.send({ type: "chat", sender, message: `§c${message}§r` });
      expect(client.getStatus().status).toBe("RECONNECTING");
      // The proxy can keep sending events even though the AFK server was lost.
      old.send({ type: "heartbeat" });
      old.send({ type: "spawn" });
      old.send({ type: "chat", sender: null, message });
      old.send({ type: "disconnect", reason: "late disconnect" });

      expect(client.getStatus().status).toBe("RECONNECTING");
      expect(client.getStatus().lastError).toBe(message);
      expect(client.getStatus().connectedSince).toBeUndefined();
      expect(consoleEvents).toContain("Reconnecting in 15s...");
      expect(consoleEvents.filter(line => line.startsWith("Reconnecting in"))).toHaveLength(1);
      expect(client.sendCommand("/sell")).toBe(false);
      expect(old.stdin.write.mock.calls.map(([line]) => JSON.parse(line)))
        .toContainEqual({ type: "disconnect" });

      vi.advanceTimersByTime(14_999);
      expect(children).toHaveLength(1);
      expect(old.kill).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(children).toHaveLength(2);
      lastChild().send({ type: "spawn" });
      expect(client.getStatus().status).toBe("ONLINE");
      expect(client.getStatus().lastError).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it.each(["disabled", "manual stop"])("respects %s when a server fallback occurs", mode => {
    vi.useFakeTimers();
    try {
      const client = makeClient({ autoReconnect: mode !== "disabled" });
      client.connect();
      const old = lastChild();
      old.send({ type: "spawn" });
      old.send({
        type: "chat", sender: null,
        message: "Verbindung zum vorherigen Server verloren - du wurdest auf einen anderen Server verschoben.",
      });
      if (mode === "manual stop") client.disconnect();
      expect(client.getStatus().status).toBe(mode === "disabled" ? "ERROR" : "OFFLINE");
      vi.advanceTimersByTime(60_000);
      expect(children).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("keeps empty-packet diagnostics, normal transfers and player quotes from triggering reconnects", () => {
    const client = makeClient();
    client.connect();
    const child = lastChild();
    child.send({ type: "spawn" });
    child.send({
      type: "behavior_log",
      message: "AFK: leeres Netzwerkpaket ohne Paket-ID übersprungen; nachfolgende Pakete werden weiter verarbeitet",
    });
    child.send({ type: "chat", sender: null, message: "Du wurdest auf einen anderen Server verschoben." });
    const message = "Verbindung zum vorherigen Server verloren – du wurdest auf einen anderen Server verschoben.";
    child.send({ type: "chat", sender: "Steve", message });
    child.send({ type: "chat", sender: null, message: `Steve: ${message}` });
    expect(client.getStatus().status).toBe("ONLINE");
    expect(client.getStatus().lastError).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("counts each confirmed sale once regardless of auto-sell timing or edition", async () => {
    const client = makeClient({ autoSellEnabled: false });
    const earnings = vi.fn();
    client.on("earning", earnings);
    client.connect();
    const sale = "+$1.071 (Basis: $630, Bonus: +$441 durch 1.7x)";
    lastChild().send({ type: "chat", sender: "HugoSMP", message: sale });
    // Old bot binaries can still emit this event; it must not double count.
    lastChild().send({ type: "sell_earning", amount: 1.071, raw: sale });
    lastChild().send({ type: "chat", sender: null, message: "You received $100 from Steve" });
    lastChild().send({ type: "chat", sender: "HugoSMP", message: sale });
    await tick();
    expect(earnings.mock.calls).toEqual([
      [{ minecraftAccountId: "acc-1", amount: 1071 }],
      [{ minecraftAccountId: "acc-1", amount: 1071 }],
    ]);
  });

  it("does not run legacy balance polling or expose old bot balance events", async () => {
    const client = makeClient({ balanceEnabled: true, balanceCommand: "/balance" } as any);
    client.connect();
    lastChild().send({ type: "spawn" });
    lastChild().send({ type: "balance", balance: 9000 });
    await tick();
    const commands = lastChild().stdin.write.mock.calls.map(([line]) => JSON.parse(line));
    expect(commands.some((cmd) => cmd.type === "query_balance")).toBe(false);
    expect(client.getStatus()).not.toHaveProperty("balance");
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

  it("emits a profile event with the resolved in-game username", async () => {
    const client = makeClient({ authType: "MICROSOFT", credentialsSecret: "bot@example.com" });
    const profiles: Array<{ username: string; uuid: string }> = [];
    client.on("profile", (p: { username: string; uuid: string }) => profiles.push(p));

    client.connect();
    lastChild().send({ type: "profile", username: "CoolBot", uuid: "uuid-123" });
    await tick();

    expect(profiles).toEqual([{ minecraftAccountId: "acc-1", username: "CoolBot", uuid: "uuid-123" }]);
  });

  it.each(["JAVA", "BEDROCK"] as const)("confirms %s sign-in to live subscribers before the server accepts the connection", async edition => {
    const client = makeClient({ edition, authType: "MICROSOFT", credentialsSecret: "bot@example.com" });
    client.connect();
    const child = lastChild();
    child.send({ type: "msa_code", verification_uri: "https://microsoft.com/link", user_code: "ABCD-EFGH", expires_in: 900 });
    await tick();
    const statuses = vi.fn();
    client.on("status", statuses);

    child.send({ type: "profile", username: "CoolBot", uuid: "uuid-123" });
    await tick();

    expect(statuses).toHaveBeenCalledTimes(1);
    expect(statuses.mock.calls[0][0]).toMatchObject({ id: "acc-1", status: "CONNECTING", authenticated: true });
    expect(statuses.mock.calls[0][0].msaSignIn).toBeUndefined();
    // A later connection failure must not be the first sign-in notification.
    child.send({ type: "connection_failed", error: "Connection timed out" });
    await tick();
    expect(statuses.mock.calls[0][0].authenticated).toBe(true);
    expect(client.getStatus().status).toBe("RECONNECTING");
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
