import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../database/prisma.js";
import { findUsernameMatches } from "./username.js";

export const accessLookupSchema = z.object({ username: z.string().trim().min(1).max(64) }).strict();
// Exact matches only; never return suggestions or a directory of users.
export const accessLookupRateLimit = {
  max: 30, timeWindow: "1 minute", hook: "preHandler" as const,
  keyGenerator: (req: FastifyRequest) => req.session?.user.id ?? req.ip,
};
export async function findAccessUser(username: string) {
  const matches = await findUsernameMatches(username);
  if (matches.length !== 1) return null;
  return prisma.user.findFirst({ where: { id: matches[0].id, status: "ACTIVE" }, select: { id: true, username: true } });
}
