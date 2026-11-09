import { expect, it } from "vitest";
import { mergeConsoleHistory, appendConsoleLogs, MAX_CONSOLE_LOGS } from "../../../frontend/src/lib/consoleBuffer.js";
import type { ConsoleLogEntry } from "../../../frontend/src/lib/types.js";
const legacy = (entry: ConsoleLogEntry): ConsoleLogEntry => ({ ...entry, id: `${entry.createdAt}-${entry.id}` });
const line = (id: string, message: string, at = 0): ConsoleLogEntry => ({ id, message, type: "CHAT", minecraftAccountId: "fixture", createdAt: new Date(at).toISOString() });

it("merges late history with live output without losing repeated messages in the same millisecond", () => {
  const history = [line("h1", "old"), line("h2", "repeated", 1)];
  const live = [legacy(line("l1", "repeated", 1)), legacy(line("l2", "repeated", 1)), legacy(line("l3", "new", 2))];
  expect(mergeConsoleHistory(history, live).map(row => row.message)).toEqual(["old", "repeated", "repeated", "new"]);
});
it("retains the most recent 20,000 rows in order when a reconnect history follows a full buffer", () => {
  const live = Array.from({ length: MAX_CONSOLE_LOGS }, (_, i) => legacy(line(String(i), String(i), i)));
  const history = [line("db-old", "old", -1), line("db-recent", String(MAX_CONSOLE_LOGS - 1), MAX_CONSOLE_LOGS - 1)];
  const result = mergeConsoleHistory(history, live);
  expect(result).toHaveLength(MAX_CONSOLE_LOGS);
  expect(result[0].message).toBe("0"); expect(result.at(-1)?.message).toBe(String(MAX_CONSOLE_LOGS - 1));
});

it("shows HTTP command receipts once even if socket/history arrive first or last", () => {
  const command = { ...line("command-id", "/home manual", 100), type: "USER_COMMAND" as const };
  const reply = line("reply-id", "Server answer", 200);
  const shown = appendConsoleLogs([reply], [command, command]);
  expect(shown.map(row => row.id)).toEqual(["command-id", "reply-id"]);
  expect(appendConsoleLogs(shown, [command])).toBe(shown);
  expect(mergeConsoleHistory([command, reply], [command, command, reply])).toEqual([command, reply]);
});

it("preserves distinct accepted commands with the same text and millisecond", () => {
  const first = { ...line("first-command", "/fixture repeat", 100), type: "USER_COMMAND" as const };
  const second = { ...first, id: "second-command" };
  expect(mergeConsoleHistory([first], [first, first, second, second])).toEqual([first, second]);
});
