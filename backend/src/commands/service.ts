import { clientManager } from "../minecraft/ClientManager.js";
import { canAccessAccount } from "../accounts/service.js";
import type { SessionContext } from "../auth/session.js";

export type CommandResult =
  | { ok: true }
  | { ok: false; reason: "FORBIDDEN" | "NOT_FOUND" | "OFFLINE" };

/**
 * Central place that enforces "a user may only run commands on Minecraft
 * accounts they are assigned to (or any account if admin)" before ever
 * touching the underlying MinecraftClient. Note: this only controls whether
 * the *bot* is allowed to send the command — the Minecraft server's own
 * permission system (OP status, permission plugins) still applies and is
 * never bypassed.
 */
export async function executeCommand(
  session: SessionContext,
  accountId: string,
  command: string,
): Promise<CommandResult> {
  const allowed = await canAccessAccount(session, accountId);
  if (!allowed) return { ok: false, reason: "FORBIDDEN" };

  const client = clientManager.get(accountId);
  if (!client) return { ok: false, reason: "NOT_FOUND" };

  const sent = client.sendCommand(command);
  return sent ? { ok: true } : { ok: false, reason: "OFFLINE" };
}
