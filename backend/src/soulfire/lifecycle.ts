import { BotDesiredState } from "@soulfiremc/sdk/generated/soulfire/bot_pb";
import { readRemoteAccount } from "./auth.js";
import { soulFireRpc } from "./rpc.js";
import { withAccountLifecycle } from "./accountLifecycle.js";

/** A controller dying must never leave an unattended bot in the shared JVM. */
export async function stopRemoteAccount(cacheDir: string): Promise<void> {
  await withAccountLifecycle(cacheDir, undefined, async () => {
    const ids = await readRemoteAccount(cacheDir);
    if (!ids) return;
    await soulFireRpc().bot.setBotsDesiredState({ instanceId: ids.instanceId, botIds: [ids.botId], desiredState: BotDesiredState.STOPPED }, { timeoutMs: 3000 });
  });
}
