import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { getRequestContext } from './request-context.js';

/**
 * Single helper for emitting audit-log rows so every call site captures
 * client IP + user agent without each caller having to remember to do it.
 * Failure to write the audit row is logged but NEVER throws — the caller's
 * primary action should always succeed even if the audit write fails.
 */
export type WriteAuditInput = {
  entityType: string;
  entityId: string;
  action: string;
  /**
   * Authenticated user id. `null` for system / pre-auth events
   * (LOGIN_FAILED, CRM webhooks, etc.).
   */
  performedBy: string | null;
  /** Free-form JSON payload (before/after diff, attempted email, etc.). */
  payload?: unknown;
  /**
   * Source request, used to extract IP + user agent. When omitted (e.g.
   * inside a background sweep), both fields are left null.
   */
  req?: Request;
};

export async function writeAudit(input: WriteAuditInput): Promise<void> {
  const ctx = input.req ? getRequestContext(input.req) : { ip: null, userAgent: null };
  try {
    await prisma.auditLog.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        performedBy: input.performedBy,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
        payload:
          input.payload === undefined
            ? Prisma.DbNull
            : (input.payload as Prisma.InputJsonValue),
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] write failed', {
      entityType: input.entityType,
      action: input.action,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
