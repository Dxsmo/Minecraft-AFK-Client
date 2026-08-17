import { prisma } from "../database/prisma.js";
import { hashPassword } from "./password.js";
import { logger } from "../logging/logger.js";
import { config } from "../config/config.js";

/**
 * Creates the initial ADMIN user from environment variables on first boot,
 * but only if no admin user exists yet. After that, the env password is
 * irrelevant — all further changes must go through the app (hashed in DB).
 */
export async function bootstrapAdmin(): Promise<void> {
  const existingAdmin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  if (existingAdmin) {
    logger.info("Admin user already exists, skipping bootstrap");
    return;
  }

  if (!config.initialAdmin.password) {
    logger.warn(
      "No admin user exists and INITIAL_ADMIN_PASSWORD is not set. " +
        "Set it in backend/.env and restart to create the initial admin.",
    );
    return;
  }

  const passwordHash = await hashPassword(config.initialAdmin.password);
  await prisma.user.create({
    data: {
      username: config.initialAdmin.username,
      passwordHash,
      role: "ADMIN",
      status: "ACTIVE",
    },
  });

  logger.info({ username: config.initialAdmin.username }, "Bootstrapped initial admin user");
}
