import { BotDesiredState, BotRuntimeState } from "@soulfiremc/sdk/generated/soulfire/bot_pb";
import { readRemoteAccount } from "./auth.js";
import { soulFireRpc } from "./rpc.js";
import { readRuntimeStatus } from "./runtimeStatus.js";
import { withAccountLifecycle } from "./accountLifecycle.js";

/** A controller dying must never leave an unattended bot in the shared JVM. */
export async function stopRemoteAccount(cacheDir: string): Promise<void> {
  await withAccountLifecycle(cacheDir, undefined, async () => {
    const ids = await readRemoteAccount(cacheDir);
    if (!ids) return;
    const rpc = soulFireRpc();
    const status = await readRuntimeStatus(rpc, ids, new AbortController().signal).catch(() => undefined);
    // Repeated STOPPED writes each require a durable transaction on the Pi.
    // Both desired and runtime state must agree before skipping a write.
    if (status?.desiredState === BotDesiredState.STOPPED && status.runtimeState === BotRuntimeState.STOPPED) return;
    await rpc.bot.setBotsDesiredState({ instanceId: ids.instanceId, botIds: [ids.botId], desiredState: BotDesiredState.STOPPED }, { timeoutMs: 30_000 });
  });
}
