import type { FastifyReply } from "fastify";
import type { ZodType } from "zod";

/**
 * Parses `data` against a zod schema. On failure, sends a 400 response with
 * field-level error details and returns undefined so the caller can `return`.
 */
export function parseOrReject<T>(
  schema: ZodType<T, any, any>,
  data: unknown,
  reply: FastifyReply,
): T | undefined {
  const result = schema.safeParse(data);
  if (!result.success) {
    reply.code(400).send({ error: "Validation failed", details: result.error.flatten() });
    return undefined;
  }
  return result.data;
}
