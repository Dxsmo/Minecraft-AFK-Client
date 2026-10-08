import type { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";

/** Allowed website usernames are ASCII; SQLite NOCASE folds their letter case.
 * Return at most two matches so legacy case-only duplicates fail closed.
 * Values remain parameterized, including strings containing SQL wildcards.
 */
export function findUsernameMatches(username: string, db: Pick<Prisma.TransactionClient, "$queryRaw"> = prisma) {
  return db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE "username" = ${username.trim()} COLLATE NOCASE LIMIT 2`;
}
