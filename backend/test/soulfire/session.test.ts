import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { BotInventoryStateResponseSchema, BotRuntimeState } from "@soulfiremc/sdk/generated/soulfire/bot_pb";
import { BotActionStatus } from "@soulfiremc/sdk/generated/soulfire/bot_live_pb";
import { writePrivateJson } from "../../src/soulfire/auth.js";

const mocks = vi.hoisted(() => ({ rpc: undefined as any }));
vi.mock("../../src/soulfire/rpc.js", () => ({ soulFireRpc: () => mocks.rpc }));
vi.mock("../../src/soulfire/versions.js", () => ({
  protocolOptions: vi.fn(async () => [{ id: "RELEASE|47", displayName: "1.8.8", keywords: ["1.8.8"] }]),
  selectProtocol: vi.fn(() => ({ id: "RELEASE|47" })),
}));
const { runSoulFire } = await import("../../src/soulfire/session.js");
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "afk-session-"));
  const abort = new AbortController(), emit = vi.fn(), queue: any[] = [];
  let deliver: ((frame?: any) => void) | undefined;
  const rpc = {
    instance: { getOrCreateInstance: vi.fn(async () => ({ id: "instance" })), updateInstanceConfigEntry: vi.fn(async () => ({})),
      getInstanceInfo: vi.fn(async () => ({ result: { case: "info", value: { config: { accounts: [] } } } })), replaceInstanceAccounts: vi.fn(async () => ({})) },
    auth: { refresh: vi.fn(), loginDeviceCode: vi.fn(), loginCredentials: vi.fn(async function* () {
      yield { data: { case: "oneSuccess", value: { account: { profileId: "bot", lastKnownName: "Fixture" } } } };
    }) },
    bot: { updateBotConfigEntry: vi.fn(async () => ({})), setBotsDesiredState: vi.fn(async () => ({})),
      getBotInfo: vi.fn(async () => ({ status: { runtimeState: BotRuntimeState.RUNNING }, liveState: {} })),
      getInventoryState: vi.fn(async () => { throw new Error("Background icon rendering is forbidden"); }),
      clickInventorySlot: vi.fn(async () => ({ success: true })), closeContainer: vi.fn(async () => ({})) },
    live: { sendChat: vi.fn(async () => ({ result: { status: BotActionStatus.COMPLETED } })),
      watchBotEvents: vi.fn(async function* () {
        while (!abort.signal.aborted) {
          const frame = await new Promise<any>(resolve => {
            const canceled = () => resolve(undefined);
            deliver = frame => { abort.signal.removeEventListener("abort", canceled); resolve(frame); };
            abort.signal.addEventListener("abort", canceled, { once: true });
          });
          if (!frame) return;
          yield frame;
        }
      }) },
  };
  mocks.rpc = rpc;
  const config = { host: "localhost", port: 25565, username: "Fixture", auth_type: "offline", edition: "JAVA" as const,
    cache_dir: dir, version: "1.8.8", autosell_enabled: true };
  let running: Promise<void> | undefined;
  cleanup.push(async () => { abort.abort(); await running?.catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const start = async () => {
    vi.useFakeTimers();
    running = runSoulFire(config, emit, abort, queue);
    await vi.waitFor(() => expect(rpc.live.watchBotEvents).toHaveBeenCalledOnce());
    await frame("snapshot", { x: 0, y: 64, z: 0, dimension: "overworld" });
  };
  const frame = async (kind: string, value: any) => { expect(deliver).toBeDefined(); deliver!({ event: { case: kind, value } }); await flush(); };
  const inventory = (menuId = "player", title = "Inventory") => create(BotInventoryStateResponseSchema, {
    menuId, layout: { title, regions: [
      ...(menuId === "player" ? [] : [{ id: "container", startIndex: 0, slotCount: 2 }]),
      { id: "player_inventory", startIndex: 2, slotCount: 2 },
    ] }, slots: [{ slot: 2, itemId: "minecraft:stone", count: 64, tooltipLines: ["Stone"] }],
  });
  return { rpc, config, emit, abort, queue, start, frame, inventory, directory: dir,
    begin: () => { running = runSoulFire(config, emit, abort, queue); return running; }, end: async () => { deliver!(undefined); await flush(); await running; } };
}

it("uses icon-free inventory events for selling and gives commands priority over the active sale", async () => {
  const f = await fixture(); await f.start();
  expect(f.rpc.live.watchBotEvents.mock.calls[0][0].filter.includeInventory).toBe(true);
  await vi.advanceTimersByTimeAsync(2000); expect(f.rpc.live.sendChat).not.toHaveBeenCalled();
  await f.frame("inventory", { state: f.inventory() });
  await vi.advanceTimersByTimeAsync(100); expect(f.rpc.live.sendChat).toHaveBeenCalledWith(expect.objectContaining({ message: "/sell" }), expect.anything());
  await f.frame("inventory", { state: f.inventory("sell", "Items verkaufen") });
  await vi.advanceTimersByTimeAsync(100); expect(f.rpc.bot.clickInventorySlot).toHaveBeenCalledWith(expect.objectContaining({ slot: 2, expectedMenuId: "sell" }), expect.anything());
  f.queue.push({ type: "chat", text: "/homes" }); await vi.advanceTimersByTimeAsync(100);
  expect(f.rpc.live.sendChat).toHaveBeenLastCalledWith(expect.objectContaining({ message: "/homes" }), expect.anything());
  expect(f.rpc.bot.closeContainer).toHaveBeenCalledTimes(1);
  expect(f.rpc.bot.getInventoryState).not.toHaveBeenCalled();
});

it("discards stale menus after stream resynchronization instead of polling the rendering endpoint", async () => {
  const f = await fixture(); await f.start(); await f.frame("inventory", { state: f.inventory() });
  await vi.advanceTimersByTimeAsync(2000); await f.frame("inventory", { state: f.inventory("old", "Items verkaufen") });
  await vi.advanceTimersByTimeAsync(100);
  const clicks = f.rpc.bot.clickInventorySlot.mock.calls.length;
  await f.frame("resyncRequired", { reason: "backpressure" });
  await vi.advanceTimersByTimeAsync(3000); expect(f.rpc.bot.clickInventorySlot).toHaveBeenCalledTimes(clicks);
  await f.frame("inventory", { state: f.inventory("new", "Personal chest") });
  await vi.advanceTimersByTimeAsync(100); expect(f.rpc.bot.clickInventorySlot).toHaveBeenCalledTimes(clicks);
  expect(f.rpc.bot.getInventoryState).not.toHaveBeenCalled();
});

it("ends the session when its event stream closes instead of operating on stale inventory forever", async () => {
  const f = await fixture(); await f.start(); await f.end();
  expect(f.abort.signal.aborted).toBe(true);
  expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "connection_failed", error: expect.stringContaining("Ereignisstream") }));
});

it("still sends a manual command when the server has already replaced its old menu", async () => {
  const f = await fixture(); await f.start(); await f.frame("inventory", { state: f.inventory("old", "Items verkaufen") });
  f.rpc.bot.closeContainer.mockRejectedValueOnce(new ConnectError("The container changed", Code.Aborted));
  f.queue.push({ type: "chat", text: "/homes" }); await vi.advanceTimersByTimeAsync(100);
  expect(f.rpc.live.sendChat).toHaveBeenCalledWith(expect.objectContaining({ message: "/homes" }), expect.anything());
  expect(f.rpc.bot.closeContainer).toHaveBeenCalledTimes(1);
  expect(f.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "warning" }));
});

it("retains the stored account and skips device login when refreshing it times out", async () => {
  const f = await fixture(); await writePrivateJson(path.join(f.directory, "soulfire.json"), { instanceId: "instance", botId: "bot" });
  f.config.auth_type = "microsoft";
  f.rpc.instance.getInstanceInfo.mockResolvedValue({ result: { case: "info", value: { config: { accounts: [{ profileId: "bot", lastKnownName: "Fixture" }] } } } } as any);
  const failure = new Error("[deadline_exceeded] the operation timed out"); f.rpc.auth.refresh.mockRejectedValue(failure);
  await expect(f.begin()).rejects.toBe(failure);
  expect(f.rpc.auth.loginDeviceCode).not.toHaveBeenCalled();
  expect(f.rpc.instance.replaceInstanceAccounts).not.toHaveBeenCalled();
});
