/** One Minecraft command per message; plain chat and control characters are rejected. */
export function isSlashCommand(text: string): boolean {
  return /^\/[^\s\p{Cc}][^\p{Cc}]*$/u.test(text);
}

export const AFK_BLOCK_MESSAGE = "Mit den Accounts über den AFK-Client ist es nicht erlaubt, Stars zu farmen!!";
/** Includes arguments, case variants and explicit plugin namespaces. */
export function isBlockedAfkCommand(text: string): boolean {
  return /^\/(?:[a-z0-9_.-]+:)?afk(?:\s|$)/i.test(text.trim());
}
