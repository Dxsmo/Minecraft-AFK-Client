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
    name: z.string().min(2).max(32).regex(/^[a-zA-Z0-9_-]+$/),
    minecraftVersion: z.string().min(1).max(16).default("1.20.4"),
    serverHost: z.string().min(1).max(255),
    serverPort: z.coerce.number().int().min(1).max(65535).default(25565),
    authType: z.enum(["OFFLINE", "MICROSOFT"]).default("OFFLINE"),
    credentialsSecret: z.string().max(320).nullable().optional(),
    credentialsPassword: z.string().max(256).nullable().optional(),
    afkEnabled: z.boolean().default(true),
    movementEnabled: z.boolean().default(false),
    afkIntervalSeconds: z.coerce.number().int().min(5).max(3600).default(30),
    autoReconnect: z.boolean().default(true),
    autoCommandEnabled: z.boolean().default(false),
    autoCommandText: z.string().max(256).default(""),
    autoCommandIntervalMinutes: z.coerce.number().int().min(1).max(1440).default(5),
  })
  .refine((data) => data.authType !== "MICROSOFT" || (!!data.credentialsSecret && !!data.credentialsPassword), {
    message: "Microsoft accounts require both an email and a password",
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
  minecraftVersion: z.string().min(1).max(16).optional(),
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
