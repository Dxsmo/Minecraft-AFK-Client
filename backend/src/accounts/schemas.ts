import { z } from "zod";

/**
 * Fields accepted when CREATING an account. `authType`, `credentialsSecret`
 * (Microsoft email) and `credentialsPassword` are only ever settable here —
 * see `updateAccountSchema` below, which deliberately omits them so they can
 * never be changed afterwards via the API. To use different credentials,
 * the account must be deleted and recreated.
 */
export const createAccountSchema = z
  .object({
    // The display name shown on the website. Provided by the user for every
    // account type (for offline accounts it is also the in-game join username).
    name: z.string().min(2).max(32).regex(/^[a-zA-Z0-9_-]+$/),
    // Empty string means "auto-detect" (the bot negotiates the protocol version
    // with the server) — see MinecraftClient.ts.
    minecraftVersion: z.string().max(16).default(""),
    serverHost: z.string().min(1).max(255),
    serverPort: z.coerce.number().int().min(1).max(65535).default(25565),
    authType: z.enum(["OFFLINE", "MICROSOFT"]).default("OFFLINE"),
    // Microsoft account email. Used as the identity for the device-code sign-in
    // and its token cache. Never exposed back to the frontend.
    credentialsSecret: z.string().max(320).nullable().optional(),
    // Microsoft account password. When provided, the bot signs in automatically
    // with email + password (falling back to the device-code link if that
    // fails, e.g. for 2FA-protected accounts). Write-once; never exposed back.
    credentialsPassword: z.string().max(256).nullable().optional(),
    afkEnabled: z.boolean().default(true),
    movementEnabled: z.boolean().default(false),
    afkIntervalSeconds: z.coerce.number().int().min(5).max(3600).default(30),
    autoReconnect: z.boolean().default(true),
    autoCommandEnabled: z.boolean().default(false),
    autoCommandText: z.string().max(256).default(""),
    autoCommandIntervalMinutes: z.coerce.number().int().min(1).max(1440).default(5),
  })
  .refine((data) => data.authType !== "MICROSOFT" || !!data.credentialsSecret, {
    message: "Microsoft accounts require an account email",
    path: ["credentialsSecret"],
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
  minecraftVersion: z.string().max(16).optional(),
  serverHost: z.string().min(1).max(255).optional(),
  serverPort: z.coerce.number().int().min(1).max(65535).optional(),
  afkEnabled: z.boolean().optional(),
  movementEnabled: z.boolean().optional(),
  afkIntervalSeconds: z.coerce.number().int().min(5).max(3600).optional(),
  autoReconnect: z.boolean().optional(),
  autoCommandEnabled: z.boolean().optional(),
  autoCommandText: z.string().max(256).optional(),
  autoCommandIntervalMinutes: z.coerce.number().int().min(1).max(1440).optional(),
});

export const assignUsersSchema = z.object({
  userIds: z.array(z.string()),
});

export const commandSchema = z.object({
  command: z.string().min(1).max(256),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
