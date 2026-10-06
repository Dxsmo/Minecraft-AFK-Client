import { describe, expect, it } from "vitest";
import { parseWorldRestartSeconds } from "../../src/minecraft/worldRestart.js";

describe("world restart countdowns", () => {
  it.each([
    ["§cDie Welt wird in §e10 Sekunden §cneu gestartet!", 10],
    ["[Weltneustart] Neustart in 5 Sekunden!", 5],
    ["Die Welt startet in 1 Minute neu.", 60],
    ["Die Farmwelt wird in 10 Sekunden neugestartet!", 10],
    ["World restart in 30 seconds", 30],
    ["Weltneustart in 0 Sekunden", 0],
  ])("parses %s", (message, seconds) => {
    expect(parseWorldRestartSeconds(message)).toBe(seconds);
  });

  it.each([
    "Neustart in 10 Sekunden", "Die Welt wurde neu gestartet",
    "Die Welt wird in 10 Sekunden gespeichert", "Teleport in 10 Sekunden",
    "Weltneustart in 99999999999999999999 Sekunden",
  ])("ignores unrelated or malformed countdowns: %s", (message) => {
    expect(parseWorldRestartSeconds(message)).toBeNull();
  });
});
