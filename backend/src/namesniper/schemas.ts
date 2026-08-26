import { z } from "zod";

// Real Mojang Java usernames are 3-16 chars, alphanumeric + underscore only.
// Empty string is allowed here (means "no desired name configured yet" — the
// account exists but sniping can't be enabled until one is set).
const desiredNameSchema = z
  .string()
  .max(16)
  .refine((v) => v === "" || /^[A-Za-z0-9_]{3,16}$/.test(v), {
    message: "Must be 3-16 characters (letters, numbers, underscore)",
  });

/**
 * Fields accepted when CREATING a Name Sniper account. Deliberately minimal:
 * only a cosmetic label and the Microsoft account email are collected up
 * front, matching the account/no-password UX used elsewhere in the app.
 * Device-code sign-in happens lazily, the first time the account is enabled.
 */
export const createSniperAccountSchema = z.object({
  label: z.string().max(48).default(""),
  email: z.string().trim().email().max(320),
});

/**
 * Fields accepted when UPDATING a Name Sniper account. `email` is write-once
 * at creation (like MinecraftAccount.credentialsSecret) and intentionally
 * omitted here.
 */
export const updateSniperAccountSchema = z.object({
  label: z.string().max(48).optional(),
  desiredName: desiredNameSchema.optional(),
  cooldownSeconds: z.coerce.number().int().min(1).max(60).optional(),
  rateLimitProtection: z.coerce.boolean().optional(),
  // Newline/comma-separated proxy URLs (http/https/socks5), one strand each.
  proxies: z.string().max(8000).optional(),
});

export const reorderSniperAccountsSchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1),
});

export type CreateSniperAccountInput = z.infer<typeof createSniperAccountSchema>;
export type UpdateSniperAccountInput = z.infer<typeof updateSniperAccountSchema>;
