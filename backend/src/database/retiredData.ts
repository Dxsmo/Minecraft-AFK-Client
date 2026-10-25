import { rm } from "node:fs/promises";
import path from "node:path";
import { prisma } from "./prisma.js";
import { config } from "../config/config.js";

/** Run before any clients start; failures must prevent startup with retained data. */
export async function purgeRetiredData(dataDir = config.dataDir): Promise<void> {
  await Promise.all(["sniper-cache", "minigame-photos", "minigame-photos-test"].map(name =>
    rm(path.join(dataDir, name), { recursive: true, force: true }),
  ));
  // Reclaim free pages and truncate WAL files left by the deletion migration.
  // SQLite executes these outside a transaction, before application writes start.
  await prisma.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
  await prisma.$executeRawUnsafe("VACUUM");
  await prisma.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
}
