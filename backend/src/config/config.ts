import "dotenv/config";
import { z } from "zod";

/**
 * Central, typed application configuration loaded once from process.env.
 * Fails fast at startup if required variables are missing/invalid instead of
 * failing later with confusing runtime errors.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_ORIGIN: z.string().default("http://localhost:5173"),

  DATABASE_URL: z.string(),

  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
  SESSION_COOKIE_NAME: z.string().default("afk_session"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  SESSION_COOKIE_SECURE: z
    .string()
    .default("true")
    .transform((v) => v === "true"),

  INITIAL_ADMIN_USERNAME: z.string().default("Desmo"),
  INITIAL_ADMIN_PASSWORD: z.string().default(""),

  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  LOGIN_RATE_LIMIT_WINDOW: z.string().default("1 minute"),

  LOG_LEVEL: z.string().default("info"),

  CORS_ORIGINS: z.string().default("http://localhost:5173"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === "production",
  host: env.HOST,
  port: env.PORT,
  publicOrigin: env.PUBLIC_ORIGIN,

  databaseUrl: env.DATABASE_URL,

  session: {
    secret: env.SESSION_SECRET,
    cookieName: env.SESSION_COOKIE_NAME,
    ttlHours: env.SESSION_TTL_HOURS,
    cookieSecure: env.SESSION_COOKIE_SECURE,
  },

  initialAdmin: {
    username: env.INITIAL_ADMIN_USERNAME,
    password: env.INITIAL_ADMIN_PASSWORD,
  },

  loginRateLimit: {
    max: env.LOGIN_RATE_LIMIT_MAX,
    window: env.LOGIN_RATE_LIMIT_WINDOW,
  },

  logLevel: env.LOG_LEVEL,

  corsOrigins: env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
} as const;
