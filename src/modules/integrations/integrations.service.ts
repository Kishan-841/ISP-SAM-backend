import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { sendCustomerActivatedAlert } from '../../services/email/notifications.service.js';
import {
  getCrmClient,
  CrmHttpError,
} from '../../services/integrations/crm/index.js';
import { lookupDisconnectionLabels } from '../commercial-changes/disconnection-reasons.js';

/** UUID stamped on audit rows for events that don't have a real user actor
 *  (CRM webhooks). Doesn't need to point at an existing user — audit_logs
 *  doesn't FK against users so a stable sentinel is fine. */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

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
    /**
     * Annual figure. CRM started sending this directly.
     * `currentMrr` (monthly) is still accepted at the boundary as a
     * backwards-compat input — the service multiplies it by 12 and stores ARC.
     */
    currentArc?: number;
    /** Legacy monthly figure. Multiplied × 12 at ingest. */
    currentMrr?: number;
    onboardingDate: string;
  };
};

/** Resolve the annual ARC from whichever field the CRM sent. */
function resolveCurrentArc(c: CustomerActivatedPayload['customer']): number {
  if (typeof c.currentArc === 'number') return c.currentArc;
  if (typeof c.currentMrr === 'number') return c.currentMrr * 12;
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

/** Payload of the `quickDisconnect.decided` webhook (CRM → SAM). Matches
 *  the contract at docs/integrations/sam-quick-disconnect-contract.md §2. */
export type QuickDisconnectDecisionPayload = {
  eventId: string;
  eventType: 'quickDisconnect.decided';
  occurredAt: string;
  commercialChangeId: string;
  decision: 'APPROVE' | 'REJECT';
  decidedBy: string;
  note?: string;
};

export type QuickDisconnectIngestResult =
  | { status: 'PROCESSED'; eventId: string; accountId: string; decision: 'APPROVE' | 'REJECT' }
  | { status: 'DUPLICATE'; eventId: string }
  | { status: 'NOT_FOUND'; eventId: string; reason: string };

/** Payload of the `commercialChange.statusChanged` webhook (CRM → SAM).
 *  Fires on EVERY workflow transition — see
 *  docs/integrations/quick-disconnect-end-to-end-spec.md §3.2. */
export type CommercialChangeStatusChangedPayload = {
  eventId: string;
  eventType: 'commercialChange.statusChanged';
  occurredAt: string;
  commercialChangeId: string;
  fromStatus?: string;
  toStatus: string;
  changedBy: string;
  note?: string;
  serviceOrderId?: string;
  serviceOrderNumber?: string;
};

export type StatusChangeIngestResult =
  | { status: 'PROCESSED'; eventId: string; accountId: string; toStatus: string }
  | { status: 'DUPLICATE'; eventId: string }
  | { status: 'NOT_FOUND'; eventId: string; reason: string };

/** Status strings that move the account into DISCONNECTING (workflow in flight). */
const IN_FLIGHT_STATUSES = new Set([
  'PENDING_DOCS_REVIEW',
  'PENDING_NOC',
  'PENDING_ACCOUNTS',
  // CRM's "post-rename" enum, also in use
  'DOCS',
  'NOC',
  'ACCOUNTS',
]);

/** Status strings that mean the workflow ended in rejection — revert account
 *  to ACTIVE per spec §4.1 (Hard revert policy). */
const REJECTION_STATUSES = new Set(['REJECTED', 'DOCS_REJECTED', 'NOC_REJECTED', 'CANCELLED']);

function startOfDayUtcPlusDays(now: Date, days: number): Date {
  const out = new Date(now);
  out.setUTCHours(0, 0, 0, 0);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

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
    //    Initial status='FAILED' is a placeholder — overwritten to PROCESSED
    //    on success, or kept FAILED with a populated statusReason on error.
    let event;
    try {
      event = await prisma.integrationEvent.create({
        data: {
          source: 'CRM',
          eventType: payload.eventType,
          externalEventId: payload.eventId,
          occurredAt: new Date(payload.occurredAt),
          status: 'FAILED',
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

    // 2. Upsert the Account. Wrap so any failure (unique-constraint, schema
    //    drift, etc.) is captured into status_reason — otherwise the row
    //    stays FAILED with no clue why and the admin /integrations page is
    //    silent about the actual cause.
    const c = payload.customer;
    const currentArc = resolveCurrentArc(c);
    let account: { id: string };
    try {
      account = await prisma.account.upsert({
        where: { externalCrmId: c.externalId },
        create: {
          clientName: c.contactName?.trim() || c.companyName,
          companyName: c.companyName,
          kittyType: 'NEW',
          contractStatus: 'ACTIVE',
          currentArc: new Prisma.Decimal(currentArc),
          // Snapshot the activation-time ARC so dashboards can show the
          // "since onboarding" delta. Set ONCE on create — never overwritten
          // on subsequent webhook replays.
          startOfPeriodArc: new Prisma.Decimal(currentArc),
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
          currentArc: new Prisma.Decimal(currentArc),
          // NB: startOfPeriodArc intentionally absent — never overwrite the
          // original snapshot. Backfill happens via the SQL fixup migration.
          email: c.email ?? null,
          mobileNumber: c.phone ?? null,
          currentPlan: c.currentPlan ?? null,
          circuitId: c.circuitId ?? null,
          bandwidthMbps: c.bandwidthMbps ?? null,
        },
        select: { id: true },
      });
    } catch (err) {
      const reason = await describeIngestError(err, c);
      await safeUpdateStatusReason(event.id, reason);
      throw err;
    }

    // 3. Mark the event processed and link the account.
    await prisma.integrationEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSED', accountId: account.id, statusReason: null },
    });

    // 4. Best-effort: notify all SAM_HEADs that a new customer is in their
    //    triage queue. Wrap the whole thing — the ingest is already PROCESSED
    //    by this point and we don't want a stray email-orchestrator failure
    //    to flip the row back or 5xx the CRM (which would trigger pointless
    //    retries of an already-applied event).
    try {
      const accountForEmail = await prisma.account.findUnique({
        where: { id: account.id },
        select: {
          id: true,
          clientName: true,
          companyName: true,
          customerCode: true,
          circuitId: true,
          currentArc: true,
          bandwidthMbps: true,
        },
      });
      if (accountForEmail) {
        await sendCustomerActivatedAlert({
          accountId: accountForEmail.id,
          account: accountForEmail,
          systemUserId: SYSTEM_USER_ID,
        });
      }
    } catch {
      // Swallowed deliberately — failure surfaces in audit_logs via the
      // orchestrator's own SENT/FAILED/MISCONFIGURED outcome row.
    }

    return { status: 'PROCESSED', accountId: account.id, eventId: event.id };
  },

  /**
   * Admin-facing list of every IntegrationEvent ever received, newest first.
   * Supports filtering by status and source, plus pagination.
   */
  /**
   * Outbound CRM failures: commercial-change rows where SAM committed
   * locally but the CRM service-order call failed (`crmStatus='FAILED'`).
   * Used by the /integrations admin page chip + drill-in so an operator
   * can spot when SAM and CRM are out of sync and chase it manually.
   *
   * Excludes rows where the change has been fully RETAINed afterwards
   * (i.e. customer was kept, so the failed CRM call is moot).
   */
  async listOutboundCrmFailures() {
    const rows = await prisma.commercialChange.findMany({
      where: { crmStatus: 'FAILED' },
      orderBy: [{ crmStatusUpdatedAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      include: {
        account: {
          select: {
            id: true,
            clientName: true,
            companyName: true,
            customerCode: true,
            kittyType: true,
            samOwner: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });
    return {
      failures: rows.map((r) => ({
        id: r.id,
        accountId: r.accountId,
        changeType: r.changeType,
        oldArc: Number(r.oldArc),
        newArc: Number(r.newArc),
        effectiveDate: r.effectiveDate.toISOString().slice(0, 10),
        crmStatus: r.crmStatus,
        crmStatusUpdatedAt: r.crmStatusUpdatedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        account: r.account,
      })),
      total: rows.length,
    };
  },

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
   * Inbound `quickDisconnect.decided` — CRM's super-admin has approved or
   * rejected a QUICK disconnect SAM raised earlier. Idempotent on eventId.
   *
   * APPROVE: account flips PENDING_QUICK_APPROVAL → DISCONNECTING with
   *          scheduledTerminationAt = today + quickRequestedDays. The
   *          existing sweepDueTerminations() picks it up on the right day.
   *
   * REJECT:  account reverts to ACTIVE, the commercial-change row stays in
   *          place for audit with quickApprovalDecision=REJECTED + note.
   *
   * Contract: docs/integrations/sam-quick-disconnect-contract.md §2
   */
  async ingestQuickDisconnectDecision(
    payload: QuickDisconnectDecisionPayload,
    ctx: IngestContext,
  ): Promise<QuickDisconnectIngestResult> {
    // 1. Reserve the eventId in integration_events. The @unique on
    //    externalEventId makes this race-safe and gives us natural dedupe.
    let event;
    try {
      event = await prisma.integrationEvent.create({
        data: {
          source: 'CRM',
          eventType: payload.eventType,
          externalEventId: payload.eventId,
          occurredAt: new Date(payload.occurredAt),
          status: 'FAILED', // overwritten on success
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
          select: { id: true },
        });
        return { status: 'DUPLICATE', eventId: existing?.id ?? payload.eventId };
      }
      throw err;
    }

    // 2. Look up the commercial change. Unknown id = 404 so CRM marks the
    //    delivery FAILED (won't retry) and an operator can investigate.
    //    We pull all the fields needed to (a) decide the new state and
    //    (b) on APPROVE, raise the CRM /service-orders so the docs → NOC →
    //    accounts → completed workflow kicks in — mirrors what the normal
    //    retentionDecision('PROCEED') path does in commercial-changes.
    const change = await prisma.commercialChange.findUnique({
      where: { id: payload.commercialChangeId },
      include: {
        account: {
          select: { id: true, contractStatus: true, externalCrmId: true },
        },
      },
    });
    if (!change) {
      const reason = `Unknown commercialChangeId ${payload.commercialChangeId}`;
      await safeUpdateStatusReason(event.id, reason);
      return { status: 'NOT_FOUND', eventId: event.id, reason };
    }

    // Defensive — only QUICK rows should ever receive this webhook.
    if (change.disconnectionMode !== 'QUICK') {
      const reason = `commercialChange ${payload.commercialChangeId} is not a QUICK disconnect (mode=${change.disconnectionMode ?? 'null'})`;
      await safeUpdateStatusReason(event.id, reason);
      return { status: 'NOT_FOUND', eventId: event.id, reason };
    }

    // 3. Apply the decision. Both branches stamp the decision metadata on
    //    the commercial-change row, then mutate the account state.
    let crmRaiseSummary: {
      crmServiceOrderId: string | null;
      crmOrderNumber: string | null;
      crmStatus: string | null;
      crmError: string | null;
    } = {
      crmServiceOrderId: null,
      crmOrderNumber: null,
      crmStatus: null,
      crmError: null,
    };
    try {
      if (payload.decision === 'APPROVE') {
        const decidedAt = new Date(payload.occurredAt);
        const days = change.quickRequestedDays ?? 1;
        const scheduledTerminationAt = startOfDayUtcPlusDays(new Date(), days);

        // Raise the CRM service order so the docs → NOC → SAM activation →
        // accounts → completed workflow tracks the actual disconnection on
        // the CRM side. Same call the normal PROCEED path uses
        // (commercial-changes.service.ts retentionDecision PROCEED branch).
        // If CRM rejects we capture the error but still advance SAM-side
        // state — the operator can chase the CRM hand-off separately.
        crmRaiseSummary = await raiseDisconnectionServiceOrder(change);

        await prisma.$transaction([
          prisma.commercialChange.update({
            where: { id: change.id },
            data: {
              quickApprovalDecision: 'APPROVED',
              quickApprovalDecidedAt: decidedAt,
              quickApprovalDecidedBy: payload.decidedBy,
              quickApprovalNote: payload.note ?? null,
              scheduledTerminationAt,
              // Mark as "decision applied" so the dashboard counts and the
              // sweepDueTerminations() reader treat this as in-flight.
              retentionDecision: 'PROCEED',
              retentionDecidedAt: decidedAt,
              // CRM service-order linkage (null on failure / Excel-imported).
              ...(crmRaiseSummary.crmServiceOrderId
                ? {
                    crmServiceOrderId: crmRaiseSummary.crmServiceOrderId,
                    crmOrderNumber: crmRaiseSummary.crmOrderNumber,
                    crmStatus: crmRaiseSummary.crmStatus,
                    crmStatusUpdatedAt: decidedAt,
                  }
                : crmRaiseSummary.crmStatus
                  ? {
                      crmStatus: crmRaiseSummary.crmStatus,
                      crmStatusUpdatedAt: decidedAt,
                    }
                  : {}),
            },
          }),
          prisma.account.update({
            where: { id: change.accountId },
            data: { contractStatus: 'DISCONNECTING' },
          }),
        ]);
      } else {
        // REJECT
        await prisma.$transaction([
          prisma.commercialChange.update({
            where: { id: change.id },
            data: {
              quickApprovalDecision: 'REJECTED',
              quickApprovalDecidedAt: new Date(payload.occurredAt),
              quickApprovalDecidedBy: payload.decidedBy,
              quickApprovalNote: payload.note ?? null,
              // Stamp a retention decision so audit trail / dashboards see
              // the row as closed (not still pending).
              retentionDecision: 'RETAIN',
              retentionDecidedAt: new Date(payload.occurredAt),
            },
          }),
          prisma.account.update({
            where: { id: change.accountId },
            data: { contractStatus: 'ACTIVE' },
          }),
        ]);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Apply failed';
      await safeUpdateStatusReason(event.id, reason);
      throw err;
    }

    // 4. Mark the integration event PROCESSED + audit.
    await prisma.integrationEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSED', accountId: change.accountId, statusReason: null },
    });
    await prisma.auditLog.create({
      data: {
        entityType: 'CommercialChange',
        entityId: change.id,
        action:
          payload.decision === 'APPROVE'
            ? 'QUICK_DISCONNECT_APPROVED'
            : 'QUICK_DISCONNECT_REJECTED',
        performedBy: SYSTEM_USER_ID,
        payload: {
          eventId: payload.eventId,
          decidedBy: payload.decidedBy,
          note: payload.note ?? null,
          // Capture the CRM service-order outcome on APPROVE so the audit
          // row tells the full story without needing to cross-reference
          // commercial_changes.crm_status.
          ...(payload.decision === 'APPROVE'
            ? {
                crmServiceOrderId: crmRaiseSummary.crmServiceOrderId,
                crmOrderNumber: crmRaiseSummary.crmOrderNumber,
                crmStatus: crmRaiseSummary.crmStatus,
                crmError: crmRaiseSummary.crmError,
              }
            : {}),
        },
      },
    });

    return {
      status: 'PROCESSED',
      eventId: event.id,
      accountId: change.accountId,
      decision: payload.decision,
    };
  },

  /**
   * Inbound `commercialChange.statusChanged` — CRM fires this on every
   * service-order workflow transition. Source of truth for the SAM-side
   * crm_status display, account contract status flips, and (on COMPLETED)
   * the final termination.
   *
   * Per spec docs/integrations/quick-disconnect-end-to-end-spec.md §3.2.
   * Idempotent on eventId.
   */
  async ingestCommercialChangeStatusChanged(
    payload: CommercialChangeStatusChangedPayload,
    ctx: IngestContext,
  ): Promise<StatusChangeIngestResult> {
    // 1. Reserve eventId via integration_events @unique → dedupe.
    let event;
    try {
      event = await prisma.integrationEvent.create({
        data: {
          source: 'CRM',
          eventType: payload.eventType,
          externalEventId: payload.eventId,
          occurredAt: new Date(payload.occurredAt),
          status: 'FAILED',
          payload: payload as unknown as Prisma.InputJsonValue,
          signatureHeader: ctx.signatureHeader,
          timestampHeader: ctx.timestampHeader,
          remoteAddr: ctx.remoteAddr,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await prisma.integrationEvent.findUnique({
          where: { externalEventId: payload.eventId },
          select: { id: true },
        });
        return { status: 'DUPLICATE', eventId: existing?.id ?? payload.eventId };
      }
      throw err;
    }

    // 2. Look up the commercial change. Unknown id = 404 (CRM marks FAILED,
    //    no retry — investigate).
    const change = await prisma.commercialChange.findUnique({
      where: { id: payload.commercialChangeId },
      include: { account: { select: { id: true, contractStatus: true } } },
    });
    if (!change) {
      const reason = `Unknown commercialChangeId ${payload.commercialChangeId}`;
      await safeUpdateStatusReason(event.id, reason);
      return { status: 'NOT_FOUND', eventId: event.id, reason };
    }

    // 3. Apply the transition. Branching on toStatus drives both crm_status
    //    persistence and any side-effects on the account row.
    const decidedAt = new Date(payload.occurredAt);
    const toStatus = payload.toStatus;

    type ChangeUpdate = Prisma.CommercialChangeUpdateInput;
    const changeUpdate: ChangeUpdate = {
      crmStatus: toStatus,
      crmStatusUpdatedAt: decidedAt,
      ...(payload.serviceOrderId ? { crmServiceOrderId: payload.serviceOrderId } : {}),
      ...(payload.serviceOrderNumber ? { crmOrderNumber: payload.serviceOrderNumber } : {}),
    };
    let accountUpdate: Prisma.AccountUpdateInput | null = null;

    if (toStatus === 'PENDING_DOCS_REVIEW' || toStatus === 'DOCS') {
      // This is the moment CRM admin's approval lands. For QUICK rows we
      // also stamp the quick-approval decision metadata + scheduled
      // termination so the SAM-side hard-termination timer kicks in.
      changeUpdate.retentionDecision = 'PROCEED';
      changeUpdate.retentionDecidedAt = decidedAt;
      if (change.disconnectionMode === 'QUICK') {
        changeUpdate.quickApprovalDecision = 'APPROVED';
        changeUpdate.quickApprovalDecidedAt = decidedAt;
        changeUpdate.quickApprovalDecidedBy = payload.changedBy;
        if (payload.note) changeUpdate.quickApprovalNote = payload.note;
        const days = change.quickRequestedDays ?? 1;
        changeUpdate.scheduledTerminationAt = startOfDayUtcPlusDays(new Date(), days);
      }
      accountUpdate = { contractStatus: 'DISCONNECTING' };
    } else if (IN_FLIGHT_STATUSES.has(toStatus)) {
      // PENDING_NOC / PENDING_ACCOUNTS (or post-rename DOCS/NOC/ACCOUNTS) —
      // workflow is in flight, account stays DISCONNECTING, just update
      // crm_status for visibility.
      if (change.account.contractStatus !== 'DISCONNECTING') {
        accountUpdate = { contractStatus: 'DISCONNECTING' };
      }
    } else if (toStatus === 'COMPLETED') {
      // Final state — terminate the account. (sweepDueTerminations would
      // also catch this on next read, but doing it inline gives the UI an
      // immediate reflection.)
      accountUpdate = { contractStatus: 'TERMINATED' };
      changeUpdate.accountAppliedAt = decidedAt;
    } else if (REJECTION_STATUSES.has(toStatus)) {
      // Hard revert per spec §4.1 — account back to ACTIVE.
      if (change.disconnectionMode === 'QUICK' && toStatus === 'REJECTED') {
        // Stage-1 reject from admin → stamp the quick-rejection metadata.
        changeUpdate.quickApprovalDecision = 'REJECTED';
        changeUpdate.quickApprovalDecidedAt = decidedAt;
        changeUpdate.quickApprovalDecidedBy = payload.changedBy;
        if (payload.note) changeUpdate.quickApprovalNote = payload.note;
      }
      accountUpdate = { contractStatus: 'ACTIVE' };
    }
    // Anything else (unknown enum) — persist the status string but don't
    // mutate the account. Better to record an unknown than to drop it.

    try {
      const ops: Prisma.PrismaPromise<unknown>[] = [
        prisma.commercialChange.update({ where: { id: change.id }, data: changeUpdate }),
      ];
      if (accountUpdate) {
        ops.push(
          prisma.account.update({ where: { id: change.accountId }, data: accountUpdate }),
        );
      }
      await prisma.$transaction(ops);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Apply failed';
      await safeUpdateStatusReason(event.id, reason);
      throw err;
    }

    await prisma.integrationEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSED', accountId: change.accountId, statusReason: null },
    });
    await prisma.auditLog.create({
      data: {
        entityType: 'CommercialChange',
        entityId: change.id,
        action: 'CRM_STATUS_CHANGED',
        performedBy: SYSTEM_USER_ID,
        payload: {
          eventId: payload.eventId,
          fromStatus: payload.fromStatus ?? null,
          toStatus,
          changedBy: payload.changedBy,
          note: payload.note ?? null,
          serviceOrderId: payload.serviceOrderId ?? null,
          serviceOrderNumber: payload.serviceOrderNumber ?? null,
        },
      },
    });

    return {
      status: 'PROCESSED',
      eventId: event.id,
      accountId: change.accountId,
      toStatus,
    };
  },

  /**
   * Best-effort writer used by error paths after an IntegrationEvent row
   * has been created. Exposed so the controller can attach a reason for
   * unexpected exceptions that escape `ingestCustomerActivated`.
   */
  async setStatusReason(eventId: string, reason: string) {
    await safeUpdateStatusReason(eventId, reason);
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

// ─── Error-shaping helpers ────────────────────────────────────────────

/**
 * Translate a thrown error from the Account upsert (or anything else in the
 * ingest pipeline) into a single human-readable string we can stash on
 * `integration_events.status_reason`. The goal is admin-readable forensics —
 * not anything machine-actionable. Anything we don't specifically recognise
 * falls through to the underlying error message.
 */
async function describeIngestError(
  err: unknown,
  customer: CustomerActivatedPayload['customer'],
): Promise<string> {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      // err.meta.target is the conflicting unique constraint. In Postgres-
      // backed Prisma this is a string[] of column names (snake_case).
      const target = (err.meta?.target ?? []) as string[] | string;
      const fields = Array.isArray(target) ? target : [String(target)];
      const fieldList = fields.join(', ');

      // For circuit_id specifically, look up the conflicting account so the
      // admin can fix the data without an extra query — this is the failure
      // mode we expect to see most often (reused circuit IDs from CRM-side
      // test data or genuine duplicates).
      if (fields.includes('circuit_id') && customer.circuitId) {
        const owner = await prisma.account.findUnique({
          where: { circuitId: customer.circuitId },
          select: { id: true, externalCrmId: true, companyName: true, clientName: true },
        });
        if (owner) {
          const ownerName = owner.companyName ?? owner.clientName ?? '(unnamed)';
          return (
            `P2002: duplicate circuit_id '${customer.circuitId}'. ` +
            `Already owned by account ${owner.id} ` +
            `(externalCrmId=${owner.externalCrmId ?? 'null'}, name='${ownerName}'). ` +
            `Fix the data on CRM side — two accounts cannot share a circuit ID.`
          );
        }
      }
      return `P2002: unique constraint violation on (${fieldList}).`;
    }
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return 'Unknown ingest error';
}

/**
 * Update status_reason without throwing. Used in catch blocks where we don't
 * want a logging failure to mask the original error we're about to re-throw.
 */
async function safeUpdateStatusReason(eventId: string, reason: string) {
  try {
    await prisma.integrationEvent.update({
      where: { id: eventId },
      data: { statusReason: reason },
    });
  } catch {
    // Intentionally silent — caller is mid-error and re-throwing.
  }
}

/**
 * Raise the CRM DISCONNECTION service order so the docs → NOC → SAM
 * activation → accounts → completed workflow kicks in on CRM side. Mirrors
 * the same call the normal retentionDecision('PROCEED') path makes in
 * commercial-changes.service.ts — kept inline (rather than refactored into
 * a shared helper) for now since the two callers have different transaction
 * boundaries.
 *
 * Never throws — failure is captured so the caller can persist crm_status=
 * 'FAILED' and surface the error in the audit row. SAM-side state advances
 * regardless; the operator chases the CRM hand-off from the integrations
 * log.
 *
 * Returns nulls + crmStatus='FAILED' on error, or nulls all the way through
 * when the kill-switch is off or the account has no externalCrmId
 * (Excel-imported leads don't have a CRM lead to raise an order against).
 */
async function raiseDisconnectionServiceOrder(change: {
  id: string;
  disconnectionCategoryId: string | null;
  disconnectionSubCategoryId: string | null;
  disconnectionReason: string | null;
  approvalFileUrl: string | null;
  poFileUrl: string | null;
  mailReceivedDate: Date | null;
  account: { externalCrmId: string | null };
}): Promise<{
  crmServiceOrderId: string | null;
  crmOrderNumber: string | null;
  crmStatus: string | null;
  crmError: string | null;
}> {
  const empty = {
    crmServiceOrderId: null,
    crmOrderNumber: null,
    crmStatus: null,
    crmError: null,
  };

  if (process.env.CRM_SERVICE_ORDERS_ENABLED !== 'true') return empty;
  if (!change.account.externalCrmId) return empty;

  const labels = lookupDisconnectionLabels(
    change.disconnectionCategoryId,
    change.disconnectionSubCategoryId,
  );
  const samRef = `SAM-${change.id.slice(0, 8).toUpperCase()}`;
  const noteParts: string[] = [samRef, 'QUICK disconnect — CRM Admin approved'];
  if (labels.category) {
    noteParts.push(
      `Reason: ${labels.category}${labels.subCategory ? ` — ${labels.subCategory}` : ''}`,
    );
  }
  if (change.disconnectionReason) noteParts.push(`Details: ${change.disconnectionReason}`);

  try {
    const order = await getCrmClient().createServiceOrder({
      customerId: change.account.externalCrmId,
      orderType: 'DISCONNECTION',
      disconnectionCategoryId: change.disconnectionCategoryId ?? undefined,
      disconnectionSubCategoryId: change.disconnectionSubCategoryId ?? undefined,
      disconnectionReason: change.disconnectionReason ?? undefined,
      approvalFileUrl: change.approvalFileUrl ?? undefined,
      poFileUrl: change.poFileUrl ?? undefined,
      mailReceivedDate: change.mailReceivedDate?.toISOString().slice(0, 10) ?? undefined,
      notes: noteParts.join(' | '),
    });
    return {
      crmServiceOrderId: order.id,
      crmOrderNumber: order.orderNumber,
      crmStatus: order.status,
      crmError: null,
    };
  } catch (err) {
    const crmError =
      err instanceof CrmHttpError
        ? `CRM ${err.statusCode}: ${err.message}`
        : err instanceof Error
          ? err.message
          : 'CRM call failed';
    // eslint-disable-next-line no-console
    console.warn(
      `[ingestQuickDisconnectDecision ${change.id}] CRM service-order failed:`,
      crmError,
    );
    return {
      crmServiceOrderId: null,
      crmOrderNumber: null,
      crmStatus: 'FAILED',
      crmError,
    };
  }
}
