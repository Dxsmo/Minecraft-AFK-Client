import { describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hasHomeRecord, homeFromHistory, rememberedHome, rememberHome, validHome } from "../../src/soulfire/homeRecovery.js";

describe("confirmed worksite recovery", () => {
  it("binds private destinations to the same account, edition and endpoint", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "afk-home-test-"));
    const owner = { host: "hugosmp.net", port: 25565, edition: "JAVA", botId: "bot-a" };
    try {
      expect(await rememberedHome(dir, owner)).toBe("");
      await rememberHome(dir, owner, "melon");
      expect(await rememberedHome(dir, owner)).toBe("melon");
      for (const changed of [{ host: "other" }, { port: 25566 }, { edition: "BEDROCK" }, { botId: "bot-b" }]) {
        expect(await rememberedHome(dir, { ...owner, ...changed })).toBe("");
      }
      expect((await stat(path.join(dir, "confirmed-home.json"))).mode & 0o777).toBe(0o600);
      await rememberHome(dir, owner, "");
      expect(await hasHomeRecord(dir)).toBe(true); // Explicit navigation clears old history permanently.
      expect(await rememberedHome(dir, owner)).toBe("");
      await writeFile(path.join(dir, "confirmed-home.json"), "corrupt");
      expect(await rememberedHome(dir, owner)).toBe("");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("migrates only a requested, confirmed home on a known matching server", () => {
    const row = (type: string, message: string, ms = 0) => ({ type, message, createdAt: new Date(100_000 + ms) });
    const start = row("SYSTEM", "Starte Minecraft-Verbindung zu hugosmp.net:25565…");
    const request = row("USER_COMMAND", "/home melon", 100);
    const confirmed = row("SERVER_MESSAGE", "[HugoSMP] Du wurdest zu deinem Home melon teleportiert!", 500);
    expect(homeFromHistory([start, request, confirmed], "hugosmp.net", 25565)).toBe("melon");
    expect(homeFromHistory([request, confirmed], "hugosmp.net", 25565)).toBe("");
    expect(homeFromHistory([start, confirmed], "hugosmp.net", 25565)).toBe("");
    expect(homeFromHistory([start, request, confirmed], "other.net", 25565)).toBe("");
    expect(homeFromHistory([start, request, { ...confirmed, message: `<attacker> ${confirmed.message}` }], "hugosmp.net", 25565)).toBe("");
    expect(homeFromHistory([start, request, { ...confirmed, createdAt: new Date(300_000) }], "hugosmp.net", 25565)).toBe("");
    expect(homeFromHistory([start, request, confirmed, row("USER_COMMAND", "/spawn", 600)], "hugosmp.net", 25565)).toBe("");
    expect(homeFromHistory([start, request, confirmed, row("USER_COMMAND", "/home melon", 600)], "hugosmp.net", 25565)).toBe("melon");
    for (const invalid of ["", "melon\n/sell", "a b", "a".repeat(65)]) expect(validHome(invalid)).toBe(false);
  });
});
