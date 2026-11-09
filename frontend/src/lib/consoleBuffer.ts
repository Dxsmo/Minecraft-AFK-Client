import type { ConsoleLogEntry } from "./types";

export const MAX_CONSOLE_LOGS = 20_000;

/** History can arrive after live lines, including several identical messages
 * in one millisecond. Preserve their multiplicity and chronological order. */
export function mergeConsoleHistory(history: ConsoleLogEntry[], live: ConsoleLogEntry[]): ConsoleLogEntry[] {
  const key = (line: ConsoleLogEntry) => JSON.stringify([line.createdAt, line.type, line.message]);
  const remaining = new Map<string, number>();
  for (const line of history) remaining.set(key(line), (remaining.get(key(line)) ?? 0) + 1);
  const ids = new Set(history.map(line => line.id));
  const seenLive = new Set<string>();
  const extra = live.filter(line => {
    if (seenLive.has(line.id)) return false;
    seenLive.add(line.id);
    if (ids.has(line.id)) {
      const count = remaining.get(key(line)) ?? 0;
      if (count) remaining.set(key(line), count - 1);
      return false;
    }
    // Only older socket events lacked a server ID. Distinct stable IDs
    // are distinct messages even when text and millisecond are identical.
    if (!line.id.startsWith(`${line.createdAt}-`)) return true;
    const count = remaining.get(key(line)) ?? 0;
    if (!count) return true;
    remaining.set(key(line), count - 1);
    return false;
  });
  return [...history, ...extra].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_CONSOLE_LOGS);
}

/** HTTP receipts, socket delivery and recovery can carry the same stable ID. */
export function appendConsoleLogs(previous: ConsoleLogEntry[], incoming: ConsoleLogEntry[]): ConsoleLogEntry[] {
  const seen = new Set(previous.map(line => line.id));
  const extra = incoming.filter(line => { if (seen.has(line.id)) return false; seen.add(line.id); return true; });
  if (!extra.length) return previous;
  return [...previous, ...extra].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_CONSOLE_LOGS);
}
