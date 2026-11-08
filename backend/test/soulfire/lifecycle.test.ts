import { beforeEach, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { BotDesiredState, BotRuntimeState, BotStatusSchema } from "@soulfiremc/sdk/generated/soulfire/bot_pb";
const f = vi.hoisted(() => ({ status: undefined as any, failed: false, stop: vi.fn(async () => ({})) }));
vi.mock("../../src/soulfire/auth.js", () => ({ readRemoteAccount: async () => ({ instanceId: "instance", botId: "bot" }) }));
vi.mock("../../src/soulfire/rpc.js", () => ({ soulFireRpc: () => ({ bot: {
  setBotsDesiredState: f.stop,
  watchBotStatuses: async function* () {
    if (f.failed) throw new Error("status unavailable");
    yield { event: { case: "snapshot", value: { bots: [f.status] } } };
  },
} }) }));
import { stopRemoteAccount } from "../../src/soulfire/lifecycle.js";
beforeEach(() => {
  f.failed = false; f.stop.mockClear();
  f.status = create(BotStatusSchema, { profileId: "bot", desiredState: BotDesiredState.STOPPED, runtimeState: BotRuntimeState.STOPPED });
});
it("does not enqueue redundant durable stops for already stopped profiles during reconciliation", async () => {
  await stopRemoteAccount("/test/reconciliation-stopped"); expect(f.stop).not.toHaveBeenCalled();
});
it("still cancels a pending start even when its runtime has not left STOPPED", async () => {
  f.status.desiredState = BotDesiredState.RUNNING;
  await stopRemoteAccount("/test/reconciliation-pending");
  expect(f.stop).toHaveBeenCalledWith({ instanceId: "instance", botIds: ["bot"], desiredState: BotDesiredState.STOPPED }, { timeoutMs: 30_000 });
});
it("does not skip stopping a running profile or hide an unavailable status service", async () => {
  f.status.runtimeState = BotRuntimeState.RUNNING;
  await stopRemoteAccount("/test/reconciliation-running"); expect(f.stop).toHaveBeenCalledTimes(1);
  f.failed = true;
  await stopRemoteAccount("/test/reconciliation-unavailable"); expect(f.stop).toHaveBeenCalledTimes(2);
});
