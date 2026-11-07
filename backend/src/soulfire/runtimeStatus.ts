import { Code, ConnectError } from "@connectrpc/connect";
import type { BotStatus } from "@soulfiremc/sdk/generated/soulfire/bot_pb";
import type { SoulFireRpc } from "./rpc.js";

/** The status manager's snapshot needs no game-thread task. A successful probe
 * distinguishes a stuck game client from an unreachable control service. */
export async function readRuntimeStatus(rpc: SoulFireRpc, ids: { instanceId: string; botId: string }, parent: AbortSignal): Promise<BotStatus> {
  const abort = new AbortController();
  const signal = AbortSignal.any([parent, abort.signal]);
  try {
    for await (const frame of rpc.bot.watchBotStatuses({ instanceId: ids.instanceId }, { signal, timeoutMs: 3000 })) {
      const event = frame.event;
      const status = event.case === "snapshot" ? event.value.bots.find(bot => bot.profileId === ids.botId)
        : event.case === "update" && event.value.profileId === ids.botId ? event.value : undefined;
      if (status) { abort.abort(); return status; }
      if (event.case === "snapshot") throw new ConnectError("SoulFire-Account fehlt im Status-Snapshot", Code.NotFound);
    }
    throw new ConnectError("SoulFire-Statusstream endete ohne Status", Code.Unavailable);
  } finally { abort.abort(); }
}
