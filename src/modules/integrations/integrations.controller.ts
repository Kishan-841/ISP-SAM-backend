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

// Inbound `quickDisconnect.decided` payload. Contract: see CRM repo
// docs/integrations/sam-quick-disconnect-contract.md §2.
const quickDisconnectDecisionSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.literal('quickDisconnect.decided'),
  occurredAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid occurredAt'),
  commercialChangeId: z.string().uuid(),
  decision: z.enum(['APPROVE', 'REJECT']),
  decidedBy: z.string().min(1),
  note: z.string().optional(),
});

// Inbound `commercialChange.statusChanged` payload — fires on every
// service-order workflow transition. Spec:
// docs/integrations/quick-disconnect-end-to-end-spec.md §3.2.
const commercialChangeStatusChangedSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.literal('commercialChange.statusChanged'),
  occurredAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid occurredAt'),
  commercialChangeId: z.string().uuid(),
  // Status strings are free-text on our side — we store whatever CRM sends.
  // Unknown enums fall through to the gray pill in the UI rather than 400'ing
  // so a CRM-side rename never crashes the integration.
  fromStatus: z.string().optional(),
  toStatus: z.string().min(1),
  changedBy: z.string().min(1),
  note: z.string().optional(),
  serviceOrderId: z.string().optional(),
  serviceOrderNumber: z.string().optional(),
});

function ctxFromReq(req: Request) {
  const r = req as VerifiedRequest;
  return {
    signatureHeader: r.crmSignature ?? null,
    timestampHeader: r.crmTimestamp ? String(r.crmTimestamp) : null,
    remoteAddr: req.ip ?? null,
  };
}

const SUPPORTED_EVENT_TYPES = [
  'customer.activated',
  'quickDisconnect.decided',
  'commercialChange.statusChanged',
] as const;

export const integrationsController = {
  /**
   * Single-URL dispatcher — peeks at body.eventType and routes to the
   * matching handler. Lets the CRM team configure ONE SAM_WEBHOOK_URL on
   * their side and stop adding a new per-event override every time we
   * agree on a new event. Signature check has already run upstream
   * (verifyCrmWebhook middleware on the route).
   */
  async dispatch(req: Request, res: Response) {
    const eventType =
      typeof req.body?.eventType === 'string' ? req.body.eventType : '';
    switch (eventType) {
      case 'customer.activated':
        return integrationsController.customerActivated(req, res);
      case 'quickDisconnect.decided':
        return integrationsController.quickDisconnectDecision(req, res);
      case 'commercialChange.statusChanged':
        return integrationsController.commercialChangeStatusChanged(req, res);
      default: {
        // Unknown eventType — record the rejection for forensics so the
        // /integrations admin page shows what landed and why we didn't
        // process it. Then 400 — fix the payload, don't retry.
        const partial = req.body && typeof req.body === 'object' ? req.body : {};
        const candidateId =
          typeof (partial as { eventId?: unknown }).eventId === 'string'
            ? (partial as { eventId: string }).eventId
            : null;
        await integrationsService.recordRejection({
          externalEventId: candidateId,
          eventType: eventType || 'unknown',
          occurredAt: null,
          reason: `dispatcher: unknown eventType '${eventType}'`,
          payload: req.body,
          ...ctxFromReq(req),
        });
        res.status(400).json({
          error: `Unknown eventType: '${eventType}'`,
          supportedEventTypes: SUPPORTED_EVENT_TYPES,
        });
        return;
      }
    }
  },

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

  /**
   * Inbound `quickDisconnect.decided` from CRM.
   * Signature already verified by the route's verifyCrmWebhook middleware
   * (same shared secret + same scheme as customer.activated per contract §1.5).
   *
   * Response codes match the contract §2.4 — what CRM expects:
   *   200 / 201 → processed (DELIVERED on CRM side, no retry)
   *   400      → bad payload (CRM marks FAILED, no retry)
   *   404      → unknown commercialChangeId (CRM marks FAILED, no retry)
   *   5xx      → transient (CRM retries with backoff)
   */
  async quickDisconnectDecision(req: Request, res: Response) {
    const parse = quickDisconnectDecisionSchema.safeParse(req.body);
    if (!parse.success) {
      const reason = parse.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      const partial = req.body && typeof req.body === 'object' ? req.body : {};
      const candidateId =
        typeof (partial as { eventId?: unknown }).eventId === 'string'
          ? (partial as { eventId: string }).eventId
          : null;
      await integrationsService.recordRejection({
        externalEventId: candidateId,
        eventType:
          typeof (partial as { eventType?: unknown }).eventType === 'string'
            ? ((partial as { eventType: string }).eventType)
            : 'quickDisconnect.decided',
        occurredAt: null,
        reason: `validation: ${reason}`,
        payload: req.body,
        ...ctxFromReq(req),
      });
      res.status(400).json({ error: 'Validation failed', detail: reason });
      return;
    }

    const result = await integrationsService.ingestQuickDisconnectDecision(
      parse.data,
      ctxFromReq(req),
    );

    if (result.status === 'DUPLICATE') {
      res
        .status(200)
        .json({ status: 'already_processed', eventId: result.eventId, deduped: true });
      return;
    }
    if (result.status === 'NOT_FOUND') {
      res.status(404).json({ status: 'not_found', reason: result.reason });
      return;
    }
    res.status(201).json({
      status: 'processed',
      eventId: result.eventId,
      accountId: result.accountId,
      decision: result.decision,
    });
  },

  /**
   * Inbound `commercialChange.statusChanged` from CRM.
   * Fires on every service-order workflow transition. Same response codes
   * as quickDisconnect.decided — 200/201 = processed (no retry), 400 = bad
   * payload (no retry), 404 = unknown commercialChangeId (no retry),
   * 5xx = transient (CRM retries).
   */
  async commercialChangeStatusChanged(req: Request, res: Response) {
    const parse = commercialChangeStatusChangedSchema.safeParse(req.body);
    if (!parse.success) {
      const reason = parse.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      const partial = req.body && typeof req.body === 'object' ? req.body : {};
      const candidateId =
        typeof (partial as { eventId?: unknown }).eventId === 'string'
          ? (partial as { eventId: string }).eventId
          : null;
      await integrationsService.recordRejection({
        externalEventId: candidateId,
        eventType:
          typeof (partial as { eventType?: unknown }).eventType === 'string'
            ? ((partial as { eventType: string }).eventType)
            : 'commercialChange.statusChanged',
        occurredAt: null,
        reason: `validation: ${reason}`,
        payload: req.body,
        ...ctxFromReq(req),
      });
      res.status(400).json({ error: 'Validation failed', detail: reason });
      return;
    }

    const result = await integrationsService.ingestCommercialChangeStatusChanged(
      parse.data,
      ctxFromReq(req),
    );

    if (result.status === 'DUPLICATE') {
      res.status(200).json({ status: 'already_processed', eventId: result.eventId, deduped: true });
      return;
    }
    if (result.status === 'NOT_FOUND') {
      res.status(404).json({ status: 'not_found', reason: result.reason });
      return;
    }
    res.status(201).json({
      status: 'processed',
      eventId: result.eventId,
      accountId: result.accountId,
      toStatus: result.toStatus,
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

  /**
   * GET /integrations/outbound-failures (ADMIN)
   * Commercial-change rows whose outbound CRM call failed
   * (`crm_status='FAILED'`). The dashboard chip + the integrations page
   * use this so an operator can spot when SAM committed locally but the
   * CRM hand-off didn't take.
   */
  async listOutboundFailures(_req: Request, res: Response) {
    const data = await integrationsService.listOutboundCrmFailures();
    res.json(data);
  },
};
