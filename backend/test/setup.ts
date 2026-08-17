import { beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { prisma } from "../src/database/prisma.js";

// Tests run against an isolated SQLite database file so they never touch
// the real development/production data. DATABASE_URL is set by the `test`
// npm script before vitest starts; migrations are applied once here.
beforeAll(() => {
  execSync("npx prisma migrate deploy", { stdio: "inherit" });
});

afterAll(async () => {
  await prisma.$disconnect();
});
