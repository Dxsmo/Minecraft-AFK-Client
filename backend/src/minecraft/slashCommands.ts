/** One Minecraft command per message; plain chat and control characters are rejected. */
export function isSlashCommand(text: string): boolean {
  return /^\/[^\s\p{Cc}][^\p{Cc}]*$/u.test(text);
}
