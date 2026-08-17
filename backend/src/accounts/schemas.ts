import { z } from "zod";

export const createAccountSchema = z.object({
  name: z.string().min(2).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  minecraftVersion: z.string().min(1).max(16).default("1.20.4"),
  serverHost: z.string().min(1).max(255),
  serverPort: z.coerce.number().int().min(1).max(65535).default(25565),
  authType: z.enum(["OFFLINE", "MICROSOFT"]).default("OFFLINE"),
  credentialsSecret: z.string().max(512).nullable().optional(),
  afkEnabled: z.boolean().default(true),
  movementEnabled: z.boolean().default(false),
  afkIntervalSeconds: z.coerce.number().int().min(5).max(3600).default(30),
  autoReconnect: z.boolean().default(true),
});

export const updateAccountSchema = createAccountSchema.partial();

export const assignUsersSchema = z.object({
  userIds: z.array(z.string()),
});

export const commandSchema = z.object({
  command: z.string().min(1).max(256),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
