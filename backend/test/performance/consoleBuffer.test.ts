import { expect, it } from "vitest";
import { mergeConsoleHistory, MAX_CONSOLE_LOGS } from "../../../frontend/src/lib/consoleBuffer.js";
import type { ConsoleLogEntry } from "../../../frontend/src/lib/types.js";
const line = (id: string, message: string, at = 0): ConsoleLogEntry => ({ id, message, type: "CHAT", minecraftAccountId: "fixture", createdAt: new Date(at).toISOString() });

it("merges late history with live output without losing repeated messages in the same millisecond", () => {
  const history = [line("h1", "old"), line("h2", "repeated", 1)];
  const live = [line("l1", "repeated", 1), line("l2", "repeated", 1), line("l3", "new", 2)];
  expect(mergeConsoleHistory(history, live).map(row => row.message)).toEqual(["old", "repeated", "repeated", "new"]);
});
it("retains the most recent 20,000 rows in order when a reconnect history follows a full buffer", () => {
  const live = Array.from({ length: MAX_CONSOLE_LOGS }, (_, i) => line(String(i), String(i), i));
  const history = [line("db-old", "old", -1), line("db-recent", String(MAX_CONSOLE_LOGS - 1), MAX_CONSOLE_LOGS - 1)];
  const result = mergeConsoleHistory(history, live);
  expect(result).toHaveLength(MAX_CONSOLE_LOGS);
  expect(result[0].message).toBe("0"); expect(result.at(-1)?.message).toBe(String(MAX_CONSOLE_LOGS - 1));
});
