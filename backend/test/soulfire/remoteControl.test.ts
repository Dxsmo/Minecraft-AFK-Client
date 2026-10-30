import { afterEach, expect, it, vi } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { glfwKey, queueRemoteEvent, type RemoteEvent } from "../../../frontend/src/lib/remoteInput.js";
const mocked = vi.hoisted(() => ({ rpc: undefined as any, active: vi.fn(async () => {}) }));
vi.mock("../../src/soulfire/rpc.js", () => ({ soulFireRpc: () => mocked.rpc }));
vi.mock("../../src/soulfire/auth.js", () => ({ readRemoteAccount: async () => ({ instanceId: "instance", botId: "bot" }) }));
vi.mock("../../src/soulfire/remoteState.js", () => ({ setRemoteControl: mocked.active }));
const { RemoteControlSession, remoteInputSchema } = await import("../../src/soulfire/remoteControl.js");
const sessions: InstanceType<typeof RemoteControlSession>[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.stop())); vi.useRealTimers(); vi.clearAllMocks(); });
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(id = "fixture") {
  mocked.rpc = { pov: { input: vi.fn(async () => ({})), watch: vi.fn(async function* (_request, options) {
    yield { inputToken: "native-private-capability", data: new Uint8Array([1, 2]), keyFrame: true, codec: "avc1.42c01e", timestampUs: 0n, width: 640, height: 360, screenOpen: false };
    await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
  }) } };
  const send = vi.fn(() => true), fail = vi.fn(), session = new RemoteControlSession(id, send, fail); sessions.push(session);
  return { session, send, fail, rpc: mocked.rpc };
}
it("forwards ordered input without exposing native capabilities or Escape", async () => {
  const f = fixture(); await f.session.start(); await tick();
  expect(JSON.stringify(f.send.mock.calls)).not.toContain("native-private-capability");
  f.session.input(remoteInputSchema.parse({ type: "input", captured: true, events: [{ kind: 0, code: 87, action: 1 }] }));
  await tick(); expect(f.rpc.pov.input).toHaveBeenLastCalledWith(expect.objectContaining({ inputToken: "native-private-capability", escape: false, sequence: 2n }), expect.anything());
  await f.session.stop(); expect(mocked.active.mock.calls).toEqual([["fixture", true], ["fixture", false]]);
});
it("allows only one controller per account and restores on disconnect", async () => {
  const f = fixture("shared"); await f.session.start();
  const other = fixture("shared"); await expect(other.session.start()).rejects.toThrow("bereits");
  await f.session.stop(); expect(mocked.active).toHaveBeenLastCalledWith("shared", false);
});
it("releases a silent browser even while the native stream stays open", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.session.start(); await tick();
  await vi.advanceTimersByTimeAsync(5500); await tick();
  expect(mocked.active).toHaveBeenLastCalledWith("fixture", false);
});
it("accepts browser heartbeats during slow preparation and starts native input as soon as the capability arrives", async () => {
  vi.useFakeTimers(); const f = fixture(); let finish!: () => void;
  mocked.active.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const preparing = f.session.start(); await tick();
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(500);
    f.session.input(remoteInputSchema.parse({ type: "input", captured: true, events: [] }));
  }
  finish(); await preparing; await tick();
  expect(f.fail).not.toHaveBeenCalled();
  expect(f.rpc.pov.input).toHaveBeenCalledWith(expect.objectContaining({ captured: true, events: [] }), expect.anything());
});
it("does not overflow on high-frequency mouse movement while native input takes four seconds", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.session.start(); await tick();
  f.rpc.pov.input.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({}), 4000)));
  const input = (events: unknown[], inputId?: number) => f.session.input(remoteInputSchema.parse({ type: "input", captured: true, events, inputId }));
  input([{ kind: 0, code: 87, action: 1 }], 1);
  for (let i = 0; i < 3000; i++) input([{ kind: 3, relative: true, x: 1, y: -1 }]);
  input([{ kind: 0, code: 87, action: 0 }], 2);
  await vi.advanceTimersByTimeAsync(3500);
  expect(f.fail).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalledWith({ type: "inputAck", inputId: 1 });
  input([]); await vi.advanceTimersByTimeAsync(500); await tick();
  expect(f.rpc.pov.input.mock.calls.at(-1)![0].events).toEqual([
    expect.objectContaining({ kind: 3, relative: true, x: 3000, y: -3000 }),
    expect.objectContaining({ kind: 0, code: 87, action: 0 }),
  ]);
  expect(f.send).toHaveBeenCalledWith({ type: "inputAck", inputId: 1 });
  expect(f.send).toHaveBeenCalledWith({ type: "inputAck", inputId: 2 });
  expect(f.fail).not.toHaveBeenCalled();
});
it("compacts pre-start pointer input, preserving the click position before the following movement", async () => {
  const f = fixture(); let finish!: () => void;
  mocked.active.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const preparing = f.session.start(); await tick();
  for (let i = 0; i < 1000; i++) f.session.input(remoteInputSchema.parse({ type: "input", captured: true, events: [{ kind: 3, x: i / 1000, y: .25 }] }));
  f.session.input(remoteInputSchema.parse({ type: "input", inputId: 1, captured: true, events: [
    { kind: 2, code: 0, action: 1 }, { kind: 3, x: .5, y: .5 }, { kind: 2, code: 0, action: 0 },
  ] }));
  finish(); await preparing; await tick();
  expect(f.fail).not.toHaveBeenCalled();
  expect(f.rpc.pov.input.mock.calls[0][0].events).toEqual([
    expect.objectContaining({ kind: 3, x: .999, y: .25 }), expect.objectContaining({ kind: 2, action: 1 }),
    expect.objectContaining({ kind: 3, x: .5, y: .5 }), expect.objectContaining({ kind: 2, action: 0 }),
  ]);
});
it("retries an acknowledgement dropped by video backpressure without replaying the native keys", async () => {
  const f = fixture(); await f.session.start(); await tick();
  f.send.mockReturnValueOnce(false);
  const input = remoteInputSchema.parse({ type: "input", inputId: 1, captured: true, events: [{ kind: 0, code: 69, action: 1 }] });
  f.session.input(input); await tick();
  f.session.input(remoteInputSchema.parse({ type: "input", captured: true, events: [] })); await tick();
  expect(f.send.mock.calls.filter(([message]) => message.type === "inputAck")).toHaveLength(2);
  expect(f.rpc.pov.input.mock.calls.flatMap(([request]) => request.events)).toHaveLength(1);
});
it("rejects duplicate input IDs and releases native keys", async () => {
  const f = fixture(); await f.session.start(); await tick();
  const input = remoteInputSchema.parse({ type: "input", inputId: 1, captured: true, events: [{ kind: 0, code: 87, action: 1 }] });
  f.session.input(input); await tick(); f.session.input(input); await tick();
  expect(f.fail).toHaveBeenCalledWith(expect.stringContaining("Reihenfolge"));
  await f.session.stop(); expect(mocked.active).toHaveBeenLastCalledWith("fixture", false);
});
it.each([
  [Code.DeadlineExceeded, "nicht rechtzeitig verarbeitet"],
  [Code.Unavailable, "Eingabeverbindung zum Minecraft-Client"],
])("reports a native input failure (%s) and restores automation", async (code, message) => {
  const f = fixture(); await f.session.start(); await tick();
  f.rpc.pov.input.mockRejectedValueOnce(new ConnectError("native fixture failure", code));
  f.session.input(remoteInputSchema.parse({ type: "input", inputId: 1, captured: true, events: [{ kind: 0, code: 87, action: 0 }] }));
  await tick();
  expect(f.fail).toHaveBeenCalledWith(expect.stringContaining(message));
  await f.session.stop(); expect(mocked.active).toHaveBeenLastCalledWith("fixture", false);
});
it("keeps a finite limit for actual key/click floods and releases the account", async () => {
  const f = fixture(); let finish!: () => void;
  mocked.active.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const preparing = f.session.start(); await tick();
  const input = remoteInputSchema.parse({ type: "input", captured: true, events: Array.from({ length: 128 }, () => ({ kind: 0, code: 87, action: 1 })) });
  f.session.input(input); f.session.input(input); f.session.input(input); await tick();
  expect(f.fail).toHaveBeenCalledWith(expect.stringContaining("Tastatur- oder Klick"));
  finish(); await preparing;
  expect(mocked.active).toHaveBeenLastCalledWith("fixture", false);
});
it("compacts browser mouse samples while retaining relative movement and mouse button order", () => {
  const events: RemoteEvent[] = [];
  for (let i = 0; i < 8000; i++) queueRemoteEvent(events, { kind: 3, relative: true, x: 1, y: -1 });
  queueRemoteEvent(events, { kind: 2, code: 0, action: 1 });
  queueRemoteEvent(events, { kind: 3, relative: false, x: .3, y: .2 });
  queueRemoteEvent(events, { kind: 3, relative: false, x: .7, y: .8 });
  queueRemoteEvent(events, { kind: 2, code: 0, action: 0 });
  expect(events).toEqual([
    { kind: 3, relative: true, x: 8000, y: -8000 }, { kind: 2, code: 0, action: 1 },
    { kind: 3, relative: false, x: .7, y: .8 }, { kind: 2, code: 0, action: 0 },
  ]);
});
it("reports a finite startup error when no frame arrives, even if the browser keeps sending heartbeats", async () => {
  vi.useFakeTimers(); const f = fixture();
  f.rpc.pov.watch.mockImplementation(async function* (_request: unknown, options: { signal: AbortSignal }) {
    await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  await f.session.start();
  for (let i = 0; i < 50; i++) {
    f.session.input(remoteInputSchema.parse({ type: "input", captured: true, events: [] }));
    await vi.advanceTimersByTimeAsync(500);
  }
  await tick(); expect(f.fail).toHaveBeenCalledWith(expect.stringContaining("kein Steuerungsbild"));
  expect(mocked.active).toHaveBeenLastCalledWith("fixture", false);
});
it("validates input size, coordinates, key codes and reserves Escape for leaving control", () => {
  const parse = (event: unknown) => remoteInputSchema.safeParse({ type: "input", captured: true, events: [event] }).success;
  expect(parse({ kind: 0, code: 87, action: 1 })).toBe(true);
  for (const event of [{ kind: 0, code: 256 }, { kind: 0, code: 87, key: "Escape" }, { kind: 3, x: 2, y: 0 }, { kind: 2, code: 8 }, { kind: 1, code: 0xd800 }]) expect(parse(event)).toBe(false);
  expect(glfwKey("KeyW")).toBe(87); expect(glfwKey("KeyE")).toBe(69); expect(glfwKey("F3")).toBe(292);
  expect(glfwKey("Escape")).toBeUndefined();
});
it("restores automation even when preparing native control fails halfway", async () => {
  const f = fixture(); mocked.active.mockRejectedValueOnce(new Error("native unavailable"));
  await expect(f.session.start()).rejects.toThrow("native unavailable");
  expect(mocked.active.mock.calls).toEqual([["fixture", true], ["fixture", false]]);
});
it("holds ownership until a cancelled preparation has restored the account", async () => {
  const f = fixture(); let finish!: () => void;
  mocked.active.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const preparing = f.session.start(); await tick(); await f.session.stop();
  const other = fixture(); await expect(other.session.start()).rejects.toThrow("bereits");
  finish(); await preparing;
  expect(mocked.active).toHaveBeenLastCalledWith("fixture", false);
});
it("releases automation after a native encoder or stream failure", async () => {
  const f = fixture();
  f.rpc.pov.watch.mockImplementation(async function* () { throw new Error("encoder unavailable"); yield {}; });
  await f.session.start(); await tick();
  expect(f.fail).toHaveBeenCalledWith("encoder unavailable");
  await f.session.stop(); expect(mocked.active).toHaveBeenLastCalledWith("fixture", false);
});
