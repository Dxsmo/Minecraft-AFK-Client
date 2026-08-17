import pino from "pino";
import { config } from "../config/config.js";

/**
 * Structured application logger. Redacts common secret-bearing fields so
 * passwords, tokens, and Minecraft credentials never end up in log output.
 */
export const logger = pino({
  level: config.logLevel,
  transport:
    config.nodeEnv === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
  redact: {
    paths: [
      "password",
      "passwordHash",
      "*.password",
      "*.passwordHash",
      "credentialsSecret",
      "*.credentialsSecret",
      "sessionSecret",
      "req.headers.cookie",
      "req.headers.authorization",
    ],
    censor: "[REDACTED]",
  },
  base: { service: "afk-backend" },
});

/**
 * Creates a child logger scoped to a specific Minecraft account, so every
 * log line related to that bot is easy to filter/search.
 */
export function accountLogger(accountId: string, accountName: string) {
  return logger.child({ accountId, accountName });
}
