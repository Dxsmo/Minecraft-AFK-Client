import { expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { purgeRetiredData } from "../../src/database/retiredData.js";

it("deletes retired tables and related logs while preserving accounts and unrelated logs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afk-upgrade-"));
  const database = new PrismaClient({ datasourceUrl: `file:${path.join(directory, "upgrade.db")}` });
  try {
    const retired = ["ItemWorthRunValue", "ItemWorthRun", "ItemWorthValue", "ItemWorthScan", "SniperLog", "SniperAccount",
      "MinigameReceipt", "MinigameSession", "MinigameChallenge", "MinigameMember", "MinigameEvent", "MinigameLobby",
      "MinigamePlayer", "MinigameContent", "MinigameStats"];
    for (const table of retired) {
      await database.$executeRawUnsafe(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY, secret TEXT)`);
      await database.$executeRawUnsafe(`INSERT INTO "${table}" VALUES ('old', 'must-be-erased')`);
    }
    await database.$executeRawUnsafe('CREATE TABLE "MinecraftAccount" (id TEXT PRIMARY KEY)');
    await database.$executeRawUnsafe('INSERT INTO "MinecraftAccount" VALUES (\'keep\')');
    await database.$executeRawUnsafe('CREATE TABLE "AuditLog" (action TEXT, targetType TEXT, details TEXT)');
    await database.$executeRawUnsafe(`INSERT INTO "AuditLog" VALUES
      ('SNIPER_ACCOUNT_UPDATE', 'SniperAccount', 'old-secret'),
      ('MINIGAME_UPDATE', NULL, 'old-photo'), ('ITEM_WORTH_START', NULL, 'old-price'),
      ('ACCOUNT_COMMAND', 'MinecraftAccount', '{"command":"/worth dirt"}'),
      ('ACCOUNT_UPDATE', 'MinecraftAccount', 'keep')`);
    await database.$executeRawUnsafe('CREATE TABLE "ConsoleLog" (message TEXT)');
    await database.$executeRawUnsafe("INSERT INTO \"ConsoleLog\" VALUES ('/worth dirt'), ('Sold items for $10')");
    const migration = await readFile(new URL("../../prisma/migrations/20261025120000_remove_retired_features/migration.sql", import.meta.url), "utf8");
    for (const sql of migration.replace(/^--.*$/gm, "").split(";").map(s => s.trim()).filter(Boolean)) {
      if (sql.startsWith("PRAGMA")) await database.$queryRawUnsafe(sql);
      else await database.$executeRawUnsafe(sql);
    }
    const tables = await database.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'table'");
    expect(tables.map(t => t.name).sort()).toEqual(["AuditLog", "ConsoleLog", "MinecraftAccount"]);
    expect(await database.$queryRawUnsafe('SELECT * FROM "MinecraftAccount"')).toEqual([{ id: "keep" }]);
    expect(await database.$queryRawUnsafe('SELECT details FROM "AuditLog"')).toEqual([{ details: "keep" }]);
    expect(await database.$queryRawUnsafe('SELECT * FROM "ConsoleLog"')).toEqual([{ message: "Sold items for $10" }]);
  } finally {
    await database.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

it("erases retired files without deleting Java or Bedrock authentication caches", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afk-file-cleanup-"));
  try {
    for (const name of ["sniper-cache", "minigame-photos", "minigame-photos-test", "mc-auth-cache"]) {
      await mkdir(path.join(directory, name, "account"), { recursive: true });
      await writeFile(path.join(directory, name, "account", "data"), "cached");
    }
    await purgeRetiredData(directory);
    await purgeRetiredData(directory);
    for (const name of ["sniper-cache", "minigame-photos", "minigame-photos-test"]) {
      await expect(stat(path.join(directory, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(path.join(directory, "mc-auth-cache", "account", "data"), "utf8")).toBe("cached");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
