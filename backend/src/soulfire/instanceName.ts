import { createHash } from "node:crypto";

/** SoulFire instance names have a 32-character limit. Website accounts can
 * have longer IDs (notably UUIDs for automatically added counterparts). */
export function soulFireInstanceName(accountId: string): string {
  return `afk-${accountId.length <= 28 ? accountId : createHash("sha256").update(accountId).digest("hex").slice(0, 28)}`;
}
