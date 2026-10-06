/** Remaining time announced by the server for a world restart. */
export function parseWorldRestartSeconds(message: string): number | null {
  const text = message.replace(/§[0-9a-u]/gi, "").toLowerCase();
  if (!/\b(\w*welt\w*|world\w*)\b/.test(text)) return null;
  if (!/neustart|restart|neu\s*gestartet|start\w*\b.*\bneu\b/.test(text)) return null;
  const countdown = text.match(/\bin\s+(\d+)\s*(sekunden?|sek\.?|seconds?|secs?|s|minuten?|min\.?|minutes?|mins?|m)\b/);
  if (!countdown) return null;
  const seconds = Number(countdown[1]) * (countdown[2].startsWith("m") ? 60 : 1);
  return Number.isSafeInteger(seconds) && seconds <= 24 * 60 * 60 ? seconds : null;
}

export const WORLD_RESTART_SELL_LEAD_MS = 10_000;
export const WORLD_RESTART_SELL_COOLDOWN_MS = 5 * 60_000;
