import { expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sqliteConnectionUrl } from "../../src/database/connectionUrl.js";

it("preserves the database path and explicit operator connection settings", () => {
  const url = sqliteConnectionUrl("file:../data/afk.db?connection_limit=3&socket_timeout=45");
  expect(url.split("?")[0]).toBe("file:../data/afk.db");
  const query = new URLSearchParams(url.split("?")[1]);
  expect(query.get("connection_limit")).toBe("3");
  expect(query.get("socket_timeout")).toBe("45");
  expect(query.get("pool_timeout")).toBe("30");
  expect(sqliteConnectionUrl("postgresql://localhost/db")).toBe("postgresql://localhost/db");
});

it("reads during an external SQLite write and preserves a queued write burst after a slow SD-card lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afk-sqlite-lock-"));
  const file = path.join(directory, "contention.db");
  const database = new PrismaClient({ datasourceUrl: sqliteConnectionUrl(`file:${file}`) });
  let external: ReturnType<typeof spawn> | undefined;
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    await database.$queryRawUnsafe("PRAGMA journal_mode=WAL");
    await database.$executeRawUnsafe("CREATE TABLE counter (value INTEGER NOT NULL)");
    await database.$executeRawUnsafe("INSERT INTO counter VALUES (0)");
    // A separate process is essential: node:sqlite and Prisma embed separate
    // SQLite copies, which cannot coordinate POSIX locks within one process.
    external = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE; UPDATE counter SET value = 1');
      process.on('message', () => { db.exec('COMMIT'); db.close(); process.exit(0); });
      process.send('locked');
    `, file], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await once(external, "message");
    const exited = once(external, "exit");
    // WAL readers see the committed value without waiting for this writer.
    expect(await database.$queryRawUnsafe("SELECT value FROM counter")).toEqual([{ value: 0 }]);
    release = setTimeout(() => external!.send!("commit"), 6_000);
    // The old default busy timeout expires after five seconds here.
    await Promise.all(Array.from({ length: 48 }, () => database.$executeRawUnsafe("UPDATE counter SET value = value + 1")));
    expect(await database.$queryRawUnsafe("SELECT value FROM counter")).toEqual([{ value: 49 }]);
    await exited;
  } finally {
    clearTimeout(release);
    external?.kill();
    await database.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
