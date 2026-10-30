import type { ConsoleLogEntry } from "./types";

export const MAX_CONSOLE_LOGS = 20_000;

/** History can arrive after live lines, including several identical messages
 * in one millisecond. Preserve their multiplicity and chronological order. */
export function mergeConsoleHistory(history: ConsoleLogEntry[], live: ConsoleLogEntry[]): ConsoleLogEntry[] {
  const key = (line: ConsoleLogEntry) => JSON.stringify([line.createdAt, line.type, line.message]);
  const remaining = new Map<string, number>();
  for (const line of history) remaining.set(key(line), (remaining.get(key(line)) ?? 0) + 1);
  const extra = live.filter(line => {
    const count = remaining.get(key(line)) ?? 0;
    if (!count) return true;
    remaining.set(key(line), count - 1);
    return false;
  });
  return [...history, ...extra].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_CONSOLE_LOGS);
}
