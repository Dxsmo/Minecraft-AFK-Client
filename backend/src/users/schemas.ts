import { z } from "zod";

export const minecraftUsernameSchema = z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? null : value,
  z.string().trim().min(3).max(16).regex(/^[a-zA-Z0-9_]+$/, "Minecraft-Namen dürfen nur Buchstaben, Zahlen und _ enthalten").nullable(),
);

export const createUserSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/, "Alphanumeric, - and _ only"),
  password: z.string().min(8).max(256),
  role: z.enum(["ADMIN", "USER"]).default("USER"),
  minecraftUsername: minecraftUsernameSchema.optional(),
});

export const updateUserSchema = z.object({
  password: z.string().min(8).max(256).optional(),
  role: z.enum(["ADMIN", "USER"]).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  minecraftUsername: minecraftUsernameSchema.optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
