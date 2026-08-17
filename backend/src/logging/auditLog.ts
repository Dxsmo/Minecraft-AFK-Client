import { prisma } from "../database/prisma.js";
import { logger } from "./logger.js";

/**
 * Records a critical admin/security-relevant action for later auditing.
 * Never include secrets in `details` (it is stored as plain JSON text).
 */
export async function recordAuditLog(params: {
  userId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId ?? null,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        details: params.details ? JSON.stringify(params.details) : undefined,
      },
    });
  } catch (err) {
    // Audit logging must never crash the request; log and move on.
    logger.error({ err }, "Failed to write audit log entry");
  }
}
