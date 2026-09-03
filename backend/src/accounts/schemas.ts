import { z } from "zod";

/**
 * Fields accepted when CREATING an account. `credentialsSecret` (the Microsoft
 * account email) is only ever settable here — see `updateAccountSchema` below,
 * which deliberately omits it so it can never be changed afterwards via the API.
 *
 * All accounts are Microsoft accounts: sign-in happens once via the interactive
 * device-code link at creation time, after which only the refresh token cached
 * on disk is used. No Minecraft password is ever collected or stored.
 */
export const createAccountSchema = z
  .object({
    // The display name shown on the website.
    name: z.string().min(2).max(32).regex(/^[a-zA-Z0-9_-]+$/),
    // Optional cosmetic label shown on the website (may contain spaces). Empty
    // falls back to `name`. Never sent to the Minecraft server.
    displayName: z.string().max(48).default(""),
    // Empty string means "auto-detect" (the bot negotiates the protocol version
    // with the server) — see MinecraftClient.ts.
    minecraftVersion: z.string().max(16).default(""),
    serverHost: z.string().min(1).max(255),
    serverPort: z.coerce.number().int().min(1).max(65535).default(25565),
    // Which Minecraft edition to connect as. JAVA uses the Azalea Rust bot;
    // BEDROCK uses the bedrock-protocol Node bot (see ClientManager binary
    // selection). Write-once at creation, like authType — the update schema
    // omits it so an account can't silently switch protocols after creation.
    edition: z.enum(["JAVA", "BEDROCK"]).default("JAVA"),
    // Microsoft account email. Used as the identity for the device-code sign-in
    // and its on-disk token cache. Required for every account. Never exposed
    // back to the frontend.
    credentialsSecret: z.string().trim().email().max(320),
    afkEnabled: z.boolean().default(true),
    movementEnabled: z.boolean().default(false),
    crouchEnabled: z.boolean().default(false),
    afkIntervalSeconds: z.coerce.number().int().min(5).max(3600).default(30),
    autoReconnect: z.boolean().default(true),
    notes: z.string().max(50).default(""),
    autoCommandEnabled: z.boolean().default(false),
    autoCommandText: z.string().max(256).default(""),
    autoCommandIntervalMinutes: z.coerce.number().int().min(1).max(1440).default(5),
    autoCommandSpanEnabled: z.boolean().default(false),
    autoCommandSpanMinSeconds: z.coerce.number().int().min(60).max(86_400).default(600),
    autoCommandSpanMaxSeconds: z.coerce.number().int().min(60).max(86_400).default(1800),
    tpAutoEnabled: z.boolean().default(false),
    tpAutoAllowlist: z
      .array(z.string().trim().min(1).max(16))
      .max(50)
      .default([])
      .transform((names) => JSON.stringify(Array.from(new Set(names)))),
    autoSellEnabled: z.boolean().default(false),
    autoSellIntervalSeconds: z.coerce.number().min(0.5).max(3600).default(60),
    autoSellCommand: z.string().max(64).default("/sell"),
    dailyCommandEnabled: z.boolean().default(false),
    dailyCommandTimes: z
      .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM"))
      .max(48)
      .default([])
      .transform((times) => JSON.stringify(Array.from(new Set(times)).sort())),
    balanceEnabled: z.boolean().default(false),
    balanceCommand: z.string().max(64).default("/balance"),
  });

/**
 * Fields accepted when UPDATING an account. Intentionally does NOT include
 * `authType`, `credentialsSecret`, or `credentialsPassword` — those are
 * write-once at creation time and enforced immutable here (any such fields
 * sent by a client are silently ignored by zod rather than erroring, since
 * they're simply not part of this schema).
 */
export const updateAccountSchema = z.object({
  name: z.string().min(2).max(32).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  displayName: z.string().max(48).optional(),
  minecraftVersion: z.string().max(16).optional(),
  serverHost: z.string().min(1).max(255).optional(),
  serverPort: z.coerce.number().int().min(1).max(65535).optional(),
  afkEnabled: z.boolean().optional(),
  movementEnabled: z.boolean().optional(),
  crouchEnabled: z.boolean().optional(),
  afkIntervalSeconds: z.coerce.number().int().min(5).max(3600).optional(),
  autoReconnect: z.boolean().optional(),
  notes: z.string().max(50).optional(),
  autoCommandEnabled: z.boolean().optional(),
  autoCommandText: z.string().max(256).optional(),
  autoCommandIntervalMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  autoCommandSpanEnabled: z.boolean().optional(),
  autoCommandSpanMinSeconds: z.coerce.number().int().min(60).max(86_400).optional(),
  autoCommandSpanMaxSeconds: z.coerce.number().int().min(60).max(86_400).optional(),
  tpAutoEnabled: z.boolean().optional(),
  tpAutoAllowlist: z
    .array(z.string().trim().min(1).max(16))
    .max(50)
    .optional()
    .transform((names) => (names ? JSON.stringify(Array.from(new Set(names))) : undefined)),
  autoSellEnabled: z.boolean().optional(),
  autoSellIntervalSeconds: z.coerce.number().min(0.5).max(3600).optional(),
  autoSellCommand: z.string().max(64).optional(),
  dailyCommandEnabled: z.boolean().optional(),
  dailyCommandTimes: z
    .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM"))
    .max(48)
    .optional()
    .transform((times) => (times ? JSON.stringify(Array.from(new Set(times)).sort()) : undefined)),
  balanceEnabled: z.boolean().optional(),
  balanceCommand: z.string().max(64).optional(),
  hugoSettingsCommand: z.string().max(64).optional(),
});

/** Body for toggling a single server-settings button. */
export const setHugoSettingSchema = z.object({
  label: z.string().min(1).max(64),
  enabled: z.boolean(),
});

export const assignUsersSchema = z.object({
  userIds: z.array(z.string()),
});

export const reorderAccountsSchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1),
});

export const commandSchema = z.object({
  command: z.string().min(1).max(256),
});

// Player inventory menu has 46 slots (0..45); move/drop use raw slot indices.
export const moveItemSchema = z.object({
  from: z.number().int().min(0).max(45),
  to: z.number().int().min(0).max(45),
});

export const dropItemSchema = z.object({
  slot: z.number().int().min(0).max(45),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
