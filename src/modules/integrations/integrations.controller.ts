import type { Request, Response } from 'express';
import { z } from 'zod';
import { integrationsService } from './integrations.service.js';
import type { VerifiedRequest } from './crm-webhook.middleware.js';

const STATUSES = ['PROCESSED', 'DUPLICATE', 'REJECTED', 'FAILED'] as const;

const customerSchema = z
  .object({
    externalId: z.string().min(1),
    companyName: z.string().min(1),
    contactName: z.string().optional().nullable(),
    email: z.string().email().optional().nullable(),
    phone: z.string().optional().nullable(),
    circuitId: z.string().optional().nullable(),
    bandwidthMbps: z.number().int().positive().optional().nullable(),
    currentPlan: z.string().optional().nullable(),
    // CRM sends `currentArc` (annual). `currentMrr` (monthly) is still
    // accepted for backwards compatibility with older payloads — the service
    // multiplies it by 12 at ingest. At least one must be provided.
    currentArc: z.number().nonnegative().optional(),
    currentMrr: z.number().nonnegative().optional(),
    onboardingDate: z
      .string()
      .refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid onboardingDate'),
  })
  .refine(
    (c) => c.currentArc !== undefined || c.currentMrr !== undefined,
    { message: 'Either currentArc or currentMrr must be provided', path: ['currentArc'] },
  );

const customerActivatedSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.literal('customer.activated'),
  occurredAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid occurredAt'),
  customer: customerSchema,
});

function ctxFromReq(req: Request) {
  const r = req as VerifiedRequest;
  return {
    signatureHeader: r.crmSignature ?? null,
    timestampHeader: r.crmTimestamp ? String(r.crmTimestamp) : null,
    remoteAddr: req.ip ?? null,
  };
}

export const integrationsController = {
  async customerActivated(req: Request, res: Response) {
    const parse = customerActivatedSchema.safeParse(req.body);
    if (!parse.success) {
      const reason = parse.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      const partial = req.body && typeof req.body === 'object' ? req.body : {};
      const candidateId =
        typeof (partial as { eventId?: unknown }).eventId === 'string'
          ? ((partial as { eventId: string }).eventId)
          : null;
      const candidateType =
        typeof (partial as { eventType?: unknown }).eventType === 'string'
          ? ((partial as { eventType: string }).eventType)
          : null;
      await integrationsService.recordRejection({
        externalEventId: candidateId,
        eventType: candidateType,
        occurredAt: null,
        reason: `validation: ${reason}`,
        payload: req.body,
        ...ctxFromReq(req),
      });
      res.status(400).json({ error: 'Validation failed', detail: reason });
      return;
    }

    const result = await integrationsService.ingestCustomerActivated(
      parse.data,
      ctxFromReq(req),
    );

    if (result.status === 'DUPLICATE') {
      res.status(200).json({
        status: 'already_processed',
        eventId: result.eventId,
        accountId: result.accountId,
      });
      return;
    }

    res.status(201).json({
      status: 'processed',
      eventId: result.eventId,
      accountId: result.accountId,
    });
  },

  async listEvents(req: Request, res: Response) {
    const status = typeof req.query.status === 'string'
      ? (STATUSES as readonly string[]).includes(req.query.status)
        ? (req.query.status as (typeof STATUSES)[number])
        : undefined
      : undefined;
    const source = typeof req.query.source === 'string' ? req.query.source : undefined;
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 25);

    const data = await integrationsService.listEvents({
      status,
      source,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 25,
    });
    res.json(data);
  },
};
