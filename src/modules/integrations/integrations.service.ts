import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';

export type CustomerActivatedPayload = {
  eventId: string;
  eventType: 'customer.activated';
  occurredAt: string;
  customer: {
    externalId: string;
    companyName: string;
    contactName?: string | null;
    email?: string | null;
    phone?: string | null;
    circuitId?: string | null;
    bandwidthMbps?: number | null;
    currentPlan?: string | null;
    /** Monthly figure. Optional — payload must provide either currentMrr or currentArc. */
    currentMrr?: number;
    /** Annual figure (= currentMrr × 12). Preferred when present. */
    currentArc?: number;
    onboardingDate: string;
  };
};

/** Resolve the monthly figure from whichever field the CRM sent. */
function resolveMonthlyMrr(c: CustomerActivatedPayload['customer']): number {
  if (typeof c.currentArc === 'number') return c.currentArc / 12;
  if (typeof c.currentMrr === 'number') return c.currentMrr;
  // Schema validation should have rejected this, but defend anyway.
  throw new Error('customer payload missing both currentMrr and currentArc');
}

export type IngestContext = {
  signatureHeader: string | null;
  timestampHeader: string | null;
  remoteAddr: string | null;
};

export type IngestResult =
  | { status: 'PROCESSED'; accountId: string; eventId: string }
  | { status: 'DUPLICATE'; eventId: string; accountId: string | null };

/**
 * Idempotently ingest a customer.activated webhook from the CRM.
 *
 * Order of operations:
 *   1. Try to insert IntegrationEvent first, keyed on externalEventId.
 *      A unique-constraint violation means the same event has already been
 *      processed — short-circuit with DUPLICATE.
 *   2. Upsert the Account (kittyType=NEW) keyed on externalCrmId.
 *   3. Update the IntegrationEvent row with the resulting accountId + status.
 *
 * The two-step approach guarantees we never double-create an Account even if
 * the CRM retries the same event.
 */
export const integrationsService = {
  async ingestCustomerActivated(
    payload: CustomerActivatedPayload,
    ctx: IngestContext,
  ): Promise<IngestResult> {
    // 1. Reserve the eventId in IntegrationEvent. Race-safe via @unique.
    let event;
    try {
      event = await prisma.integrationEvent.create({
        data: {
          source: 'CRM',
          eventType: payload.eventType,
          externalEventId: payload.eventId,
          occurredAt: new Date(payload.occurredAt),
          status: 'FAILED', // updated on success below
          payload: payload as unknown as Prisma.InputJsonValue,
          signatureHeader: ctx.signatureHeader,
          timestampHeader: ctx.timestampHeader,
          remoteAddr: ctx.remoteAddr,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await prisma.integrationEvent.findUnique({
          where: { externalEventId: payload.eventId },
          select: { id: true, accountId: true },
        });
        return {
          status: 'DUPLICATE',
          eventId: existing?.id ?? payload.eventId,
          accountId: existing?.accountId ?? null,
        };
      }
      throw err;
    }

    // 2. Upsert the Account.
    const c = payload.customer;
    const monthlyMrr = resolveMonthlyMrr(c);
    const account = await prisma.account.upsert({
      where: { externalCrmId: c.externalId },
      create: {
        clientName: c.contactName?.trim() || c.companyName,
        companyName: c.companyName,
        kittyType: 'NEW',
        contractStatus: 'ACTIVE',
        currentMrr: new Prisma.Decimal(monthlyMrr),
        onboardingDate: new Date(c.onboardingDate),
        externalCrmId: c.externalId,
        email: c.email ?? null,
        mobileNumber: c.phone ?? null,
        currentPlan: c.currentPlan ?? null,
        circuitId: c.circuitId ?? null,
        bandwidthMbps: c.bandwidthMbps ?? null,
      },
      update: {
        companyName: c.companyName,
        clientName: c.contactName?.trim() || c.companyName,
        currentMrr: new Prisma.Decimal(monthlyMrr),
        email: c.email ?? null,
        mobileNumber: c.phone ?? null,
        currentPlan: c.currentPlan ?? null,
        circuitId: c.circuitId ?? null,
        bandwidthMbps: c.bandwidthMbps ?? null,
      },
      select: { id: true },
    });

    // 3. Mark the event processed and link the account.
    await prisma.integrationEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSED', accountId: account.id, statusReason: null },
    });

    return { status: 'PROCESSED', accountId: account.id, eventId: event.id };
  },

  /**
   * Admin-facing list of every IntegrationEvent ever received, newest first.
   * Supports filtering by status and source, plus pagination.
   */
  async listEvents(opts: {
    status?: 'PROCESSED' | 'DUPLICATE' | 'REJECTED' | 'FAILED';
    source?: string;
    page?: number;
    pageSize?: number;
  } = {}) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25));
    const where = {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.source ? { source: opts.source } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.integrationEvent.count({ where }),
      prisma.integrationEvent.findMany({
        where,
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // Look up linked accounts in one query.
    const accountIds = Array.from(
      new Set(rows.map((r) => r.accountId).filter((id): id is string => !!id)),
    );
    const accounts = accountIds.length
      ? await prisma.account.findMany({
          where: { id: { in: accountIds } },
          select: { id: true, clientName: true, companyName: true, customerCode: true },
        })
      : [];
    const accountMap = new Map(accounts.map((a) => [a.id, a]));

    return {
      events: rows.map((r) => ({
        ...r,
        account: r.accountId ? accountMap.get(r.accountId) ?? null : null,
      })),
      total,
      page,
      pageSize,
    };
  },

  /**
   * Record a webhook that we refused to process (bad signature, validation
   * failure, etc). Best-effort — failures here are swallowed so they don't
   * mask the original 4xx/5xx the caller is about to receive.
   */
  async recordRejection(input: {
    externalEventId: string | null;
    eventType: string | null;
    occurredAt: Date | null;
    reason: string;
    payload: unknown;
    signatureHeader: string | null;
    timestampHeader: string | null;
    remoteAddr: string | null;
  }) {
    if (!input.externalEventId) return;
    try {
      await prisma.integrationEvent.create({
        data: {
          source: 'CRM',
          eventType: input.eventType ?? 'unknown',
          externalEventId: input.externalEventId,
          occurredAt: input.occurredAt,
          status: 'REJECTED',
          statusReason: input.reason,
          payload: (input.payload ?? {}) as Prisma.InputJsonValue,
          signatureHeader: input.signatureHeader,
          timestampHeader: input.timestampHeader,
          remoteAddr: input.remoteAddr,
        },
      });
    } catch {
      // The eventId may already exist (a malicious replay would land here).
      // Either way the receipt is logged once; ignore the second attempt.
    }
  },
};
