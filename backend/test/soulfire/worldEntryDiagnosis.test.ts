import { expect, it, vi } from "vitest";
import { BotDesiredState, BotRuntimeState } from "@soulfiremc/sdk/generated/soulfire/bot_pb";
import { diagnoseWorldEntry } from "../../scripts/diagnose-world-entry.mjs";

const ids = { instanceId: "instance", botId: "bot" };
const status = { profileId: "bot", desiredState: BotDesiredState.RUNNING, runtimeState: BotRuntimeState.STARTING };

it("reads startup status independently of an unresponsive game client and closes the subscription", async () => {
  let signal: AbortSignal | undefined;
  let closed = false;
  const rpc = { bot: {
    watchBotStatuses: vi.fn(async function* (_request, options) {
      signal = options.signal;
      try { yield { event: { case: "snapshot", value: { bots: [status] } } }; }
      finally { closed = true; }
    }),
    getBotInfo: vi.fn(async () => { throw new Error("[deadline_exceeded] timed out"); }),
  } };
  const result = await diagnoseWorldEntry(rpc, ids);
  expect(result.control.runtimeState).toBe("STARTING");
  expect(result.game.error).toContain("deadline_exceeded");
  expect(signal?.aborted).toBe(true);
  expect(closed).toBe(true);
  expect(rpc.bot.getBotInfo).toHaveBeenCalledWith(ids, { timeoutMs: 5000 });
});

it("reports only player presence and selected status fields, omitting inventory and auth/config data", async () => {
  const rpc = { bot: {
    watchBotStatuses: async function* () { yield { event: { case: "snapshot", value: { bots: [status] } } }; },
    getBotInfo: async () => ({ status, liveState: { inventory: "private-inventory" },
      config: { accessToken: "private-token" }, account: "private-account-data" }),
  } };
  const result = await diagnoseWorldEntry(rpc, ids);
  expect(result.game.playerPresent).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private-");
  expect(Object.keys(result.game)).toEqual(["status", "playerPresent"]);
});

it("keeps a missing or unavailable control status separate from the game query result", async () => {
  const rpc = { bot: {
    watchBotStatuses: async function* () { yield { event: { case: "snapshot", value: { bots: [{ ...status, profileId: "other" }] } } }; },
    getBotInfo: async () => ({ status: { ...status, runtimeState: BotRuntimeState.RUNNING } }),
  } };
  const result = await diagnoseWorldEntry(rpc, ids);
  expect(result.control.error).toContain("fehlt");
  expect(result.game).toMatchObject({ status: { runtimeState: "RUNNING" }, playerPresent: false });
});

it("returns a bounded transport error without serializing credentials attached to it", async () => {
  const rpc = { bot: {
    watchBotStatuses: async function* () { throw Object.assign(new Error("unavailable"), { authorization: "private-token" }); },
    getBotInfo: async () => { throw new Error("x".repeat(5000)); },
  } };
  const result = await diagnoseWorldEntry(rpc, ids);
  expect(result.control).toEqual({ error: "unavailable" });
  expect(result.game.error).toHaveLength(800);
  expect(JSON.stringify(result)).not.toContain("private-token");
});
