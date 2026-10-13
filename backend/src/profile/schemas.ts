import { z } from "zod";

const ids = z.array(z.string().min(1).max(160)).max(10000)
  .refine(value => new Set(value).size === value.length, "Duplicate IDs are not allowed");

export const preferencesSchema = z.object({
  accountOrder: ids.default([]),
  blurredAccountIds: ids.default([]),
  uploaderOrder: ids.default([]),
  collapsedUploaderIds: ids.default([]),
}).strict();

export const preferencesPatchSchema = z.object({
  accountOrder: ids.optional(),
  uploaderOrder: ids.optional(),
  blur: z.object({ accountId: z.string().min(1).max(160), value: z.boolean() }).strict().optional(),
  collapse: z.object({ uploaderId: z.string().min(1).max(160), value: z.boolean() }).strict().optional(),
}).strict().refine(value => Object.keys(value).length > 0, "No preference changes provided");

export type DashboardPreferences = z.infer<typeof preferencesSchema>;
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;
