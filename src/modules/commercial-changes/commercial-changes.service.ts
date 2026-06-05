import crypto from 'node:crypto';
import type { CommercialChangeType, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { buildAccountsTeamDraft, type EmailDraft } from './notification-bridge.js';
import { lookupDisconnectionLabels } from './disconnection-reasons.js';
import {
  getCrmClient,
  CrmHttpError,
  type CreateServiceOrderInput,
  type ServiceOrderType,
} from '../../services/integrations/crm/index.js';
import { pushQuickDisconnectRequest } from '../../services/integrations/crm/crm-quick-disconnect-client.js';
import { getApprovalFileUploader } from '../../services/storage/cloudinary-storage.js';
import {
  sendCommercialChangeAlert,
  sendCrmStatusChangeAlert,
} from '../../services/email/notifications.service.js';

export type Requester = { id: string; role: UserRole };

export type CommitInput = {
  accountId: string;
  changeType: CommercialChangeType;
  /** Annual ₹ — what every layer of the platform now speaks. */
  newArc: number;
  newBandwidthMbps: number | null;
  effectiveDate: Date;
  /** Date SAM received the customer's email approving the change. Optional
   *  at the API layer (legacy rows have none); the form enforces required. */
  mailReceivedDate: Date | null;
  reason: string | null;
  /**
   * Approval and PO are EACH optional, but at least one must be provided.
   * Controller enforces the at-least-one rule before calling commit().
   */
  approvalFile?: { buffer: Buffer; originalName: string };
  poFile?: { buffer: Buffer; originalName: string };
  performedByUserId: string;
  // Disconnection-only.
  disconnectionCategoryId?: string;
  disconnectionSubCategoryId?: string;
  disconnectionReason?: string;
  /** 'NORMAL' (default) — the existing 21-day retention flow.
   *  'QUICK' — skip retention, wait for CRM Admin to approve, then
   *           terminate in `quickRequestedDays` days. Gated by the
   *           QUICK_DISCONNECT_ENABLED env flag. */
  disconnectionMode?: 'NORMAL' | 'QUICK';
  /** Required when disconnectionMode='QUICK'. 1..15 days from approval to
   *  actual termination. */
  quickRequestedDays?: number;
  /** Required when disconnectionMode='QUICK'. Free text justification shown
   *  to the CRM Admin verbatim on their approval queue. */
  quickApprovalReason?: string;
  /** Optional notes forwarded to CRM as `notes` on the service-order request. */
  notes?: string;
  /** When true (and SAM_TEST_MODE permits), the doc-attachment requirement is
   *  skipped and the audit log stamps `testMode: true`. The controller
   *  validates the env-permission gate before passing this through. */
  testMode?: boolean;
};

export type CommitResult = {
  commercialChange: {
    id: string;
    accountId: string;
    changeType: CommercialChangeType;
    oldArc: number;
    newArc: number;
    effectiveDate: string;
    mailReceivedDate: string | null;
    approvalFileUrl: string | null;
    approvalFilePublicId: string | null;
    poFileUrl: string | null;
    poFilePublicId: string | null;
    crmServiceOrderId: string | null;
    crmOrderNumber: string | null;
    crmStatus: string | null;
  };
  emailDraft: EmailDraft;
  /**
   * Outcome of the CRM service-order call.
   *  - `ok: true`              — CRM order created
   *  - `ok: false`             — CRM call attempted and failed
   *  - `ok: 'disabled'`        — CRM kill-switch is off
   *  - `ok: 'local-only'`      — account has no externalCrmId (Excel-imported);
   *                              the change was applied immediately.
   *  - `ok: 'probable-churn'`  — DISCONNECTION rows enter the 21-day retention
   *                              window. No CRM order is raised until SAM
   *                              picks PROCEED on day 21.
   */
  crm:
    | { ok: true; orderId: string; orderNumber: string; status: string }
    | { ok: false; error: string; status?: number }
    | { ok: 'disabled' }
    | { ok: 'local-only' }
    | { ok: 'probable-churn' }
    | { ok: 'pending-quick-approval' };
};

export const PROBABLE_CHURN_WINDOW_DAYS = 21;
export const DISCONNECTION_NOTICE_DAYS = 10;
export const QUICK_DISCONNECT_MAX_DAYS = 15;

function isQuickDisconnectEnabled(): boolean {
  return process.env.QUICK_DISCONNECT_ENABLED === 'true';
}

/**
 * Admin-only input for backfilling a disconnection that already happened
 * (typically discovered during onboarding when an imported customer is
 * marked Active but the operator knows they were disconnected on, say,
 * 14-Apr). No CRM round-trip, no approval queue — the event is in the
 * past, the customer is gone, this is bookkeeping.
 */
export type BackfillDisconnectionInput = {
  accountId: string;
  /** Last billing date — used as effectiveDate and accountAppliedAt. */
  effectiveDate: Date;
  /** Free-text reason (from the operator's spreadsheet). Stored on the
   *  commercial_change row so the dashboard / drill-down can show "why". */
  reason: string;
  performedByUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
};

export type BackfillDisconnectionResult = {
  commercialChange: {
    id: string;
    accountId: string;
    effectiveDate: string;
    oldArc: number;
  };
  account: {
    id: string;
    clientName: string;
    contractStatus: string;
  };
};

export const commercialChangesService = {
  /**
   * Backfill a DISCONNECTION that already happened in real life.
   *
   * Differs from the normal commit() flow:
   *  - No CRM service-order created (event is in the past, CRM has its own)
   *  - No 21-day retention window (event is in the past)
   *  - No document attachment requirement
   *  - retentionDecision pre-stamped as PROCEED
   *  - accountAppliedAt stamped to effectiveDate so the dashboard waterfall
   *    counts this as a real termination immediately
   *  - account.contractStatus flipped to TERMINATED + currentArc=0 in the
   *    same transaction
   *
   * Idempotent guards: we still allow re-runs (e.g. updating the reason),
   * but each one creates a new row — the operator should fix dates in-place
   * via the existing field-edit flow if they need to correct a backfill.
   */
  async backfillDisconnection(
    input: BackfillDisconnectionInput,
  ): Promise<BackfillDisconnectionResult> {
    const account = await prisma.account.findUnique({
      where: { id: input.accountId },
      select: {
        id: true,
        clientName: true,
        currentArc: true,
        contractStatus: true,
      },
    });
    if (!account) throw new Error('Account not found');

    // Allow backfill on any non-terminated account. Operators often
    // re-activate a wrongly-imported "Deactive" row before running backfill,
    // so we accept ACTIVE / PENDING / EXPIRED / etc. We block TERMINATED
    // because a terminated row already has its disconnection captured by
    // the import or a previous backfill — re-running would double-count.
    if (account.contractStatus === 'TERMINATED') {
      throw new Error(
        'ACCOUNT_ALREADY_TERMINATED: This customer is already TERMINATED. Backfilling again would double-count the disconnection in the dashboard.',
      );
    }

    const oldArc = Number(account.currentArc);
    const effectiveDate = startOfDayUTC(input.effectiveDate);
    const reason = input.reason.trim();

    const result = await prisma.$transaction(async (tx) => {
      // 1. Write the commercial_change row, fully stamped as if the entire
      //    workflow had already completed (because in reality, it has).
      const change = await tx.commercialChange.create({
        data: {
          accountId: input.accountId,
          changeType: 'DISCONNECTION',
          oldArc,
          newArc: 0,
          oldBandwidthMbps: null,
          newBandwidthMbps: null,
          effectiveDate,
          clientApprovalAttached: false,
          createdBy: input.performedByUserId,
          reason,
          disconnectionReason: reason,
          disconnectionMode: 'NORMAL',
          // Pre-stamp the retention decision so the timeline view shows the
          // customer chose PROCEED at the time of disconnection (rather than
          // an artificial "21 days from now").
          retentionPromptDueAt: effectiveDate,
          retentionDecision: 'PROCEED',
          retentionDecidedAt: effectiveDate,
          scheduledTerminationAt: effectiveDate,
          // Idempotency marker — set so the dashboard waterfall counts this
          // as a real applied termination right away.
          accountAppliedAt: effectiveDate,
          // No CRM round-trip — record as locally-completed.
          crmStatus: 'BACKFILL_LOCAL',
          crmStatusUpdatedAt: new Date(),
          activationDate: effectiveDate,
        },
      });

      // 2. Apply to the account.
      const updatedAccount = await tx.account.update({
        where: { id: input.accountId },
        data: {
          contractStatus: 'TERMINATED',
          currentArc: 0,
        },
        select: { id: true, clientName: true, contractStatus: true },
      });

      // 3. Audit trail — captures admin + IP + UA + the historical date.
      await tx.auditLog.create({
        data: {
          entityType: 'CommercialChange',
          entityId: change.id,
          action: 'BACKFILL_DISCONNECTION',
          performedBy: input.performedByUserId,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          payload: {
            accountId: input.accountId,
            clientName: account.clientName,
            effectiveDate: effectiveDate.toISOString().slice(0, 10),
            oldArc,
            reason,
            note: 'Historical disconnection — no CRM service-order raised.',
          },
        },
      });

      return { change, updatedAccount };
    });

    return {
      commercialChange: {
        id: result.change.id,
        accountId: result.change.accountId,
        effectiveDate: result.change.effectiveDate.toISOString().slice(0, 10),
        oldArc,
      },
      account: result.updatedAccount,
    };
  },

  async commit(input: CommitInput): Promise<CommitResult> {
    const account = await prisma.account.findUnique({
      where: { id: input.accountId },
    });
    if (!account) {
      throw new Error('Account not found');
    }

    // Lifecycle guard — closed/closing accounts must not accept further
    // commercial changes, otherwise SAM and CRM drift. The controller maps
    // each error to 422 with the message verbatim so the form can surface it.
    if (account.contractStatus === 'TERMINATED') {
      throw new Error(
        'ACCOUNT_TERMINATED: This customer has been disconnected. No further commercial changes can be raised.',
      );
    }
    if (account.contractStatus === 'DISCONNECTING') {
      throw new Error(
        'ACCOUNT_DISCONNECTING: This customer is in the 10-day disconnection notice. Wait for termination or escalate to SAM_HEAD/ADMIN.',
      );
    }
    if (
      account.contractStatus === 'PROBABLE_CHURN' &&
      input.changeType === 'DISCONNECTION'
    ) {
      throw new Error(
        'DISCONNECTION_IN_FLIGHT: A disconnection is already in the 21-day retention window. Either retain via a rate revision or wait for the day-21 prompt.',
      );
    }
    if (account.contractStatus === 'PENDING_QUICK_APPROVAL') {
      throw new Error(
        'ACCOUNT_PENDING_QUICK_APPROVAL: A quick-disconnect request is awaiting CRM admin approval. Wait for the decision before raising another change.',
      );
    }

    // Quick-disconnect validation. Only applies when the caller explicitly
    // set mode=QUICK on a DISCONNECTION row; everything else routes through
    // the existing 21-day retention flow.
    const isQuick =
      input.changeType === 'DISCONNECTION' && input.disconnectionMode === 'QUICK';
    if (isQuick) {
      if (!isQuickDisconnectEnabled()) {
        throw new Error(
          'QUICK_DISCONNECT_DISABLED: Quick disconnect is not enabled on this environment. Set QUICK_DISCONNECT_ENABLED=true once the CRM admin queue is live.',
        );
      }
      const days = input.quickRequestedDays ?? -1;
      if (!Number.isInteger(days) || days < 0 || days > QUICK_DISCONNECT_MAX_DAYS) {
        throw new Error(
          `QUICK_DISCONNECT_INVALID_DAYS: quickRequestedDays must be an integer between 0 and ${QUICK_DISCONNECT_MAX_DAYS}. (0 = terminate immediately on approval.)`,
        );
      }
      const reason = (input.quickApprovalReason ?? '').trim();
      if (reason.length < 10) {
        throw new Error(
          'QUICK_DISCONNECT_REASON_REQUIRED: quickApprovalReason must be at least 10 characters — CRM admin needs the justification to make an informed decision.',
        );
      }
    }

    const performingUser = await prisma.user.findUnique({
      where: { id: input.performedByUserId },
    });
    if (!performingUser) {
      throw new Error('Authenticated user not found');
    }

    // Pre-generate the commercial-change UUID so the Cloudinary folder path
    // can include it. Lets us upload BEFORE writing the row, so a failed
    // upload doesn't leave a half-baked DB row. (Orphan Cloudinary files
    // from a failed transaction are cheap; orphan DB rows confuse audit.)
    const commercialChangeId = crypto.randomUUID();

    if (!input.approvalFile && !input.poFile && !input.testMode) {
      // Defensive — controller already gates this, but a service-level
      // guard keeps the rule honest if commit() is called from elsewhere.
      // The testMode flag is passed by the controller only when both the
      // env permits and the request asked for it.
      throw new Error('At least one of approvalFile or poFile is required');
    }

    // 1. Upload whichever attachments are present, in parallel.
    //    Folder layout: sam-software/po-and-mail-acceptance/<id>/<kind>/<filename>
    const uploader = getApprovalFileUploader();
    const [approvalUpload, poUpload] = await Promise.all([
      input.approvalFile
        ? uploader.uploadApprovalFile({
            buffer: input.approvalFile.buffer,
            originalName: input.approvalFile.originalName,
            commercialChangeId,
            kind: 'approval',
          })
        : Promise.resolve(null),
      input.poFile
        ? uploader.uploadApprovalFile({
            buffer: input.poFile.buffer,
            originalName: input.poFile.originalName,
            commercialChangeId,
            kind: 'po',
          })
        : Promise.resolve(null),
    ]);

    const oldArc = Number(account.currentArc);
    const oldBandwidth = account.bandwidthMbps ?? null;

    // 2. Transaction: create commercial_change row + audit log.
    //    Account state is INTENTIONALLY NOT updated here. The account row
    //    only mirrors the change once CRM moves the order to COMPLETED —
    //    until then SAM should reflect what CRM is actually billing, not
    //    what the operator submitted. See applyChangeToAccount().
    const result = await prisma.$transaction(async (tx) => {
      const change = await tx.commercialChange.create({
        data: {
          id: commercialChangeId,
          accountId: input.accountId,
          changeType: input.changeType,
          oldArc,
          newArc: input.newArc,
          effectiveDate: input.effectiveDate,
          // True iff at least the approval file was attached. PO-only
          // submissions still set this false so the compliance signal
          // ("client approval attached") stays honest.
          clientApprovalAttached: !!approvalUpload,
          approvalFileUrl: approvalUpload?.secureUrl ?? null,
          approvalFilePublicId: approvalUpload?.publicId ?? null,
          poFileUrl: poUpload?.secureUrl ?? null,
          poFilePublicId: poUpload?.publicId ?? null,
          createdBy: input.performedByUserId,
          reason: input.reason,
          oldBandwidthMbps: oldBandwidth,
          newBandwidthMbps: input.newBandwidthMbps,
          mailReceivedDate: input.mailReceivedDate,
          disconnectionCategoryId: input.disconnectionCategoryId ?? null,
          disconnectionSubCategoryId: input.disconnectionSubCategoryId ?? null,
          disconnectionReason: input.disconnectionReason ?? null,
          // Quick-disconnect fields. Mode defaults to 'NORMAL' on DISCONNECTION
          // rows for clarity; left NULL for non-disconnection rows.
          disconnectionMode:
            input.changeType === 'DISCONNECTION'
              ? (input.disconnectionMode ?? 'NORMAL')
              : null,
          quickRequestedDays: isQuick ? (input.quickRequestedDays ?? null) : null,
          quickApprovalReason: isQuick ? (input.quickApprovalReason ?? null) : null,
        },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'CommercialChange',
          entityId: change.id,
          action: 'COMMIT',
          performedBy: input.performedByUserId,
          payload: {
            accountId: input.accountId,
            changeType: input.changeType,
            oldArc,
            newArc: input.newArc,
            effectiveDate: input.effectiveDate.toISOString(),
            approvalFileUrl: approvalUpload?.secureUrl ?? null,
            approvalFilePublicId: approvalUpload?.publicId ?? null,
            poFileUrl: poUpload?.secureUrl ?? null,
            poFilePublicId: poUpload?.publicId ?? null,
            ...(input.testMode && !input.approvalFile && !input.poFile
              ? { testMode: true }
              : {}),
          },
        },
      });

      return change;
    });

    // 3. Forward to CRM as a service order (gated by CRM_SERVICE_ORDERS_ENABLED).
    //    For accounts without an externalCrmId (Excel-imported / never synced
    //    from CRM), there is no service order to raise — apply the change to
    //    the account row immediately so dashboards reflect it. This branch
    //    runs irrespective of the CRM kill-switch since the kill-switch only
    //    gates the outbound CRM call, which doesn't apply here.
    //
    //    DISCONNECTION is special: it always enters the 21-day probable-churn
    //    window first (regardless of CRM-sync status). No CRM order is raised
    //    until SAM picks PROCEED on the day-21 retention prompt — that path
    //    runs in retentionDecision() below.
    const crmEnabled = process.env.CRM_SERVICE_ORDERS_ENABLED === 'true';
    let crm: CommitResult['crm'];
    let crmServiceOrderId: string | null = null;
    let crmOrderNumber: string | null = null;
    let crmStatus: string | null = null;
    // Auto-retain hook: if the account is currently in PROBABLE_CHURN and SAM
    // is raising a non-disconnection commercial change, the customer is
    // staying — cancel the pending disconnection as RETAIN. Mirrors the
    // "Retain → opens rate-revision form" flow on the Probable Churn page.
    if (input.changeType !== 'DISCONNECTION' && account.contractStatus === 'PROBABLE_CHURN') {
      await autoRetainPendingDisconnection(input.accountId, input.performedByUserId);
    }

    if (input.changeType === 'DISCONNECTION') {
      if (isQuick) {
        // QUICK path: skip the 21-day retention. Where the approval queue
        // lives depends on the customer's kitty:
        //   BASE → in-house SAM admin queue (/quick-approvals). No CRM call.
        //   NEW  → CRM admin queue (existing behaviour).
        // Both branches stamp the account PENDING_QUICK_APPROVAL.
        await enterPendingQuickApproval(result.id);
        if (account.kittyType === 'BASE') {
          // No outbound CRM call — SAM admin will approve/reject in-app via
          // POST /commercial-changes/:id/sam-quick-decision.
          crm = { ok: 'pending-quick-approval' };
        } else {
          // NEW kitty: existing CRM admin approval flow.
          await notifyCrmQuickDisconnectRequested({
            commercialChange: result,
            account,
            performingUser,
          });
          crm = { ok: 'pending-quick-approval' };
        }
      } else {
        await enterProbableChurn(result.id);
        crm = { ok: 'probable-churn' };
      }
    } else if (!account.externalCrmId) {
      await applyChangeToAccount(result.id);
      crm = { ok: 'local-only' };
    } else if (!crmEnabled) {
      crm = { ok: 'disabled' };
    } else {
      try {
        const crmInput = buildServiceOrderInput(
          input,
          account.externalCrmId,
          result.id,
          approvalUpload?.secureUrl ?? null,
          poUpload?.secureUrl ?? null,
        );
        const order = await getCrmClient().createServiceOrder(crmInput);
        crmServiceOrderId = order.id;
        crmOrderNumber = order.orderNumber;
        crmStatus = order.status;
        await prisma.commercialChange.update({
          where: { id: result.id },
          data: {
            crmServiceOrderId,
            crmOrderNumber,
            crmStatus,
            crmStatusUpdatedAt: new Date(),
          },
        });
        crm = {
          ok: true,
          orderId: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
        };
      } catch (err) {
        crm =
          err instanceof CrmHttpError
            ? { ok: false, error: err.message, status: err.statusCode }
            : { ok: false, error: err instanceof Error ? err.message : 'CRM call failed' };
      }
    }

    const emailDraft = buildAccountsTeamDraft({
      account,
      samOwnerName: performingUser.name,
      changeType: input.changeType,
      oldArc,
      newArc: input.newArc,
      effectiveDate: input.effectiveDate,
      reason: input.reason,
    });

    // Fire the accounts-team notification. Best-effort — failure is logged
    // (in audit_logs) but never bubbles up. While the email transport is a
    // stub this returns 'skipped' or 'failed'; once the real transport is
    // plugged in via getEmailClient(), this becomes a real delivery.
    await sendCommercialChangeAlert({
      commercialChangeId: result.id,
      account,
      changeType: input.changeType,
      oldArc,
      newArc: input.newArc,
      oldBandwidthMbps: oldBandwidth,
      newBandwidthMbps: input.newBandwidthMbps,
      effectiveDate: input.effectiveDate,
      mailReceivedDate: input.mailReceivedDate,
      samOwnerName: performingUser.name,
      reason: input.reason,
      performedByUserId: input.performedByUserId,
      testMode: input.testMode,
    });

    return {
      commercialChange: {
        id: result.id,
        accountId: result.accountId,
        changeType: result.changeType,
        oldArc: Number(result.oldArc),
        newArc: Number(result.newArc),
        effectiveDate: result.effectiveDate.toISOString(),
        mailReceivedDate: result.mailReceivedDate?.toISOString() ?? null,
        approvalFileUrl: approvalUpload?.secureUrl ?? null,
        approvalFilePublicId: approvalUpload?.publicId ?? null,
        poFileUrl: poUpload?.secureUrl ?? null,
        poFilePublicId: poUpload?.publicId ?? null,
        crmServiceOrderId,
        crmOrderNumber,
        crmStatus,
      },
      emailDraft,
      crm,
    };
  },

  /**
   * Resolve which Cloudinary URL the requester is allowed to download
   * for a given (commercial-change, kind) pair. Used by the file-proxy
   * endpoint to gate access on the SAM side before redirecting to
   * Cloudinary.
   *
   * Scoping mirrors `list()` above:
   *   SAM       → only the account they own
   *   SAM_HEAD  → currently sees all (matches existing list() behaviour)
   *   ADMIN     → all
   *
   * Throws `Error('Commercial change not found')` for non-existent IDs
   * AND for IDs the requester isn't allowed to see (so the controller
   * can map both cases to 404 without leaking existence).
   * Throws `Error('NO_FILE')` if the kind requested has no URL stored.
   */
  async getFileUrl(opts: {
    commercialChangeId: string;
    kind: 'approval' | 'po';
    requester: Requester;
  }): Promise<{ url: string; accountId: string }> {
    const change = await prisma.commercialChange.findUnique({
      where: { id: opts.commercialChangeId },
      select: {
        id: true,
        accountId: true,
        approvalFileUrl: true,
        poFileUrl: true,
        account: { select: { samOwnerId: true } },
      },
    });
    if (!change) throw new Error('Commercial change not found');
    if (
      opts.requester.role === 'SAM' &&
      change.account.samOwnerId !== opts.requester.id
    ) {
      // Pretend it doesn't exist — don't leak existence to non-owners.
      throw new Error('Commercial change not found');
    }
    const url = opts.kind === 'approval' ? change.approvalFileUrl : change.poFileUrl;
    if (!url) throw new Error('NO_FILE');
    return { url, accountId: change.accountId };
  },

  async list(opts: { type?: CommercialChangeType; requester: Requester }) {
    // SAMs see only their own; SAM_HEAD/ADMIN see all
    const accountWhere =
      opts.requester.role === 'SAM' ? { samOwnerId: opts.requester.id } : undefined;

    return prisma.commercialChange.findMany({
      where: {
        ...(opts.type ? { changeType: opts.type } : {}),
        ...(accountWhere ? { account: accountWhere } : {}),
      },
      include: {
        account: {
          select: {
            id: true,
            clientName: true,
            customerCode: true,
            circuitId: true,
            kittyType: true,
            // externalCrmId — null = Excel-imported (no CRM bridge), so the
            // UI can render "Local-only" instead of misleading CRM cells.
            externalCrmId: true,
          },
        },
      },
      orderBy: [{ effectiveDate: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * Pull the latest CRM-side status for one commercial change and persist it.
   * Returns the updated row. No-op if the change isn't linked to a CRM order.
   *
   * Triggers the deferred account update if (and only if) CRM has just
   * marked the order as COMPLETED.
   */
  async refreshCrmStatus(commercialChangeId: string) {
    const change = await prisma.commercialChange.findUnique({
      where: { id: commercialChangeId },
      include: {
        account: {
          select: {
            externalCrmId: true,
            clientName: true,
            companyName: true,
            customerCode: true,
            circuitId: true,
            samOwnerId: true,
          },
        },
      },
    });
    if (!change) throw new Error('Commercial change not found');
    if (!change.crmServiceOrderId || !change.account.externalCrmId) {
      return change; // nothing to refresh
    }

    const orders = await getCrmClient().listServiceOrders({
      customerId: change.account.externalCrmId,
    });
    const order = orders.find((o) => o.id === change.crmServiceOrderId);
    if (!order) return change;

    const previousStatus = change.crmStatus;
    const updated = await prisma.commercialChange.update({
      where: { id: commercialChangeId },
      data: {
        crmStatus: order.status,
        crmStatusUpdatedAt: new Date(),
        activationDate: order.activationDate ? new Date(order.activationDate) : null,
      },
    });

    // Fire status-transition notifications BEFORE the account-mirror step
    // so the SAM is alerted even if the apply step fails.
    if (
      previousStatus !== order.status &&
      (order.status === 'PENDING_SAM_ACTIVATION' || order.status === 'COMPLETED')
    ) {
      await sendCrmStatusChangeAlert({
        commercialChangeId,
        kind: order.status,
        account: change.account,
        changeType: change.changeType,
        oldArc: Number(change.oldArc),
        newArc: Number(change.newArc),
        crmOrderNumber: change.crmOrderNumber,
        // The actor here is technically the operator who hit "refresh",
        // but we don't have their id in this scope. Stamp the SAM owner
        // (or system uuid for unassigned customers) — keeps audit-trail
        // queryable per-SAM.
        performedByUserId: change.account.samOwnerId ?? '00000000-0000-0000-0000-000000000000',
      });
    }

    // CRM has finished — mirror the change onto the account row exactly once.
    // DISCONNECTION rows are NOT terminated here: even if CRM races through
    // PENDING_NOC → COMPLETED in under 10 days, the contractual notice
    // period (scheduledTerminationAt) is the source of truth. The lazy
    // sweep terminates the account when that date passes.
    if (
      updated.crmStatus === 'COMPLETED' &&
      !updated.accountAppliedAt &&
      updated.changeType !== 'DISCONNECTION'
    ) {
      return applyChangeToAccount(updated.id);
    }
    return updated;
  },

  /**
   * SAM-side action for the PENDING_SAM_ACTIVATION → PENDING_ACCOUNTS
   * transition. Forwards the date to CRM, then mirrors the new status
   * (PENDING_ACCOUNTS) onto the SAM row.
   */
  async setActivationDate(commercialChangeId: string, activationDate: Date) {
    const change = await prisma.commercialChange.findUnique({
      where: { id: commercialChangeId },
    });
    if (!change) throw new Error('Commercial change not found');
    if (!change.crmServiceOrderId) {
      throw new Error('Commercial change has no CRM service-order to update');
    }
    const order = await getCrmClient().setActivationDate(
      change.crmServiceOrderId,
      activationDate,
    );
    const updated = await prisma.commercialChange.update({
      where: { id: commercialChangeId },
      data: {
        crmStatus: order.status,
        crmStatusUpdatedAt: new Date(),
        activationDate,
      },
    });
    // setActivationDate moves to PENDING_ACCOUNTS, not COMPLETED — the
    // account update happens in the next refreshCrmStatus once CRM
    // Accounts processes the order. Defensive check kept anyway.
    if (updated.crmStatus === 'COMPLETED' && !updated.accountAppliedAt) {
      return applyChangeToAccount(updated.id);
    }
    return updated;
  },

  /**
   * Day-21 retention prompt outcome. SAM picks RETAIN (customer stays, account
   * returns to ACTIVE) or PROCEED (account moves to DISCONNECTING, scheduled
   * for termination in 10 days; CRM service-order is raised if synced).
   *
   * Authorization is handled at the controller layer. Validation:
   *   - change must be a DISCONNECTION row
   *   - decision must not have been set already (terminal state)
   *   - PROCEED requires retentionPromptDueAt <= today (RETAIN is allowed any
   *     time — a customer can change their mind mid-window)
   */
  /**
   * Admin-only queue: pending QUICK-disconnect requests for BASE-kitty
   * customers that need a SAM-admin decision. NEW kitty rows are routed
   * to CRM (handled by the integrations webhook) and are excluded.
   *
   * Returned shape includes the account + the requesting SAM so the
   * /quick-approvals page can render full context without round-trips.
   */
  async listPendingSamQuickApprovals() {
    const rows = await prisma.commercialChange.findMany({
      where: {
        changeType: 'DISCONNECTION',
        disconnectionMode: 'QUICK',
        quickApprovalDecision: null,
        account: { kittyType: 'BASE' },
      },
      orderBy: [{ createdAt: 'asc' }],
      include: {
        account: {
          select: {
            id: true,
            clientName: true,
            companyName: true,
            customerCode: true,
            circuitId: true,
            kittyType: true,
            currentArc: true,
            contractStatus: true,
            samOwner: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });
    return rows.map((c) => ({
      id: c.id,
      accountId: c.accountId,
      oldArc: Number(c.oldArc),
      quickRequestedDays: c.quickRequestedDays,
      quickApprovalReason: c.quickApprovalReason,
      disconnectionReason: c.disconnectionReason,
      effectiveDate: c.effectiveDate.toISOString().slice(0, 10),
      requestedAt: c.createdAt.toISOString(),
      account: {
        id: c.account.id,
        clientName: c.account.clientName,
        companyName: c.account.companyName,
        customerCode: c.account.customerCode,
        circuitId: c.account.circuitId,
        kittyType: c.account.kittyType,
        currentArc: Number(c.account.currentArc),
        contractStatus: c.account.contractStatus,
        samOwner: c.account.samOwner,
      },
    }));
  },

  /**
   * SAM-admin decision on a pending QUICK-disconnect request (BASE kitty
   * only — NEW kitty still routes through the CRM webhook). Mirrors what
   * `integrations.service.ts` does on a CRM webhook approve/reject, but
   * stays entirely in SAM: no CRM service-order raised.
   *
   *  - APPROVE → quickApprovalDecision=APPROVED, retentionDecision=PROCEED,
   *              scheduledTerminationAt = today + quickRequestedDays,
   *              account → DISCONNECTING. The lazy sweep
   *              (sweepDueTerminations) will terminate the account when
   *              scheduledTerminationAt hits.
   *  - REJECT  → quickApprovalDecision=REJECTED, retentionDecision=RETAIN,
   *              account back to ACTIVE.
   */
  async samQuickDecision(opts: {
    commercialChangeId: string;
    decision: 'APPROVE' | 'REJECT';
    note: string | null;
    performedByUserId: string;
    ipAddress: string | null;
    userAgent: string | null;
  }) {
    const change = await prisma.commercialChange.findUnique({
      where: { id: opts.commercialChangeId },
      include: { account: true },
    });
    if (!change) throw new Error('Commercial change not found');
    if (change.changeType !== 'DISCONNECTION' || change.disconnectionMode !== 'QUICK') {
      throw new Error('Not a quick-disconnect row');
    }
    if (change.quickApprovalDecision) {
      throw new Error(
        `ALREADY_DECIDED: This quick-disconnect was already ${change.quickApprovalDecision.toLowerCase()}.`,
      );
    }
    if (change.account.kittyType !== 'BASE') {
      throw new Error(
        'NEW_BASE_NOT_LOCAL: Quick disconnects on NEW-base customers are approved via CRM admin, not in SAM.',
      );
    }

    const decidedAt = new Date();
    const decidedBy = opts.performedByUserId;
    const note = opts.note?.trim() || null;

    if (opts.decision === 'APPROVE') {
      const days = change.quickRequestedDays ?? 1;
      const scheduledTerminationAt = startOfDayUTC(addDays(new Date(), days));
      await prisma.$transaction([
        prisma.commercialChange.update({
          where: { id: change.id },
          data: {
            quickApprovalDecision: 'APPROVED',
            quickApprovalDecidedAt: decidedAt,
            quickApprovalDecidedBy: decidedBy,
            quickApprovalNote: note,
            scheduledTerminationAt,
            retentionDecision: 'PROCEED',
            retentionDecidedAt: decidedAt,
            // No CRM service-order raised. Mark the row so reports can tell
            // it apart from a CRM-completed disconnection.
            crmStatus: 'SAM_LOCAL_APPROVED',
            crmStatusUpdatedAt: decidedAt,
          },
        }),
        prisma.account.update({
          where: { id: change.accountId },
          data: { contractStatus: 'DISCONNECTING' },
        }),
        prisma.auditLog.create({
          data: {
            entityType: 'CommercialChange',
            entityId: change.id,
            action: 'QUICK_DISCONNECT_APPROVED',
            performedBy: decidedBy,
            ipAddress: opts.ipAddress,
            userAgent: opts.userAgent,
            payload: {
              source: 'SAM_LOCAL',
              decidedBy,
              note,
              quickRequestedDays: days,
              scheduledTerminationAt: scheduledTerminationAt.toISOString().slice(0, 10),
            },
          },
        }),
      ]);
    } else {
      // REJECT path. Defensive guard on the account update: only flip back
      // to ACTIVE if the account is still PENDING_QUICK_APPROVAL. Without
      // this, a race where the account has drifted to PROBABLE_CHURN or
      // DISCONNECTING via a separate flow would have us silently
      // resurrecting it. Prisma throws P2025 when the where doesn't match,
      // which rolls back the whole $transaction — caller can retry.
      await prisma.$transaction([
        prisma.commercialChange.update({
          where: { id: change.id },
          data: {
            quickApprovalDecision: 'REJECTED',
            quickApprovalDecidedAt: decidedAt,
            quickApprovalDecidedBy: decidedBy,
            quickApprovalNote: note,
            retentionDecision: 'RETAIN',
            retentionDecidedAt: decidedAt,
            crmStatus: 'SAM_LOCAL_REJECTED',
            crmStatusUpdatedAt: decidedAt,
          },
        }),
        prisma.account.update({
          where: { id: change.accountId, contractStatus: 'PENDING_QUICK_APPROVAL' },
          data: { contractStatus: 'ACTIVE' },
        }),
        prisma.auditLog.create({
          data: {
            entityType: 'CommercialChange',
            entityId: change.id,
            action: 'QUICK_DISCONNECT_REJECTED',
            performedBy: decidedBy,
            ipAddress: opts.ipAddress,
            userAgent: opts.userAgent,
            payload: {
              source: 'SAM_LOCAL',
              decidedBy,
              note,
            },
          },
        }),
      ]);
    }

    return prisma.commercialChange.findUniqueOrThrow({
      where: { id: change.id },
      include: { account: { select: { id: true, contractStatus: true } } },
    });
  },

  async retentionDecision(
    commercialChangeId: string,
    decision: 'RETAIN' | 'PROCEED',
    performedByUserId: string,
  ) {
    const change = await prisma.commercialChange.findUnique({
      where: { id: commercialChangeId },
      include: { account: true },
    });
    if (!change) throw new Error('Commercial change not found');
    if (change.changeType !== 'DISCONNECTION') {
      throw new Error('Retention decision only applies to disconnection rows');
    }
    if (change.retentionDecision) {
      throw new Error('Retention has already been decided for this disconnection');
    }
    const today = startOfDayUTC(new Date());
    if (
      decision === 'PROCEED' &&
      change.retentionPromptDueAt &&
      change.retentionPromptDueAt.getTime() > today.getTime()
    ) {
      throw new Error('PROCEED is only allowed once the 21-day retention window has elapsed');
    }

    const decidedAt = new Date();

    if (decision === 'RETAIN') {
      const [updated] = await prisma.$transaction([
        prisma.commercialChange.update({
          where: { id: commercialChangeId },
          data: { retentionDecision: 'RETAIN', retentionDecidedAt: decidedAt },
        }),
        prisma.account.update({
          where: { id: change.accountId },
          data: { contractStatus: 'ACTIVE' },
        }),
        prisma.auditLog.create({
          data: {
            entityType: 'CommercialChange',
            entityId: commercialChangeId,
            action: 'RETENTION_RETAINED',
            performedBy: performedByUserId,
            payload: {
              accountId: change.accountId,
              previousStatus: change.account.contractStatus,
            },
          },
        }),
      ]);
      return updated;
    }

    // PROCEED branch — schedule termination, optionally raise CRM order.
    const scheduledTermination = startOfDayUTC(decidedAt);
    scheduledTermination.setUTCDate(scheduledTermination.getUTCDate() + DISCONNECTION_NOTICE_DAYS);

    // Forward the disconnection to the CRM so both systems stay in sync —
    // the customer is being disconnected on the CRM side once the 10-day
    // notice expires, just as on SAM. Sends SAM-local slug IDs (see
    // disconnection-reasons.ts) which require matching rows on the CRM
    // side — see docs/INTEGRATION_CRM.md for the exact seed expected.
    //
    // If the CRM rejects (missing rows / validation), we persist
    // crmStatus='FAILED' and capture the error in the audit log instead of
    // failing the whole PROCEED. The SAM-side state still advances because
    // SAM has committed to disconnecting the customer; the operator can
    // chase the CRM hand-off separately.
    let crmServiceOrderId: string | null = null;
    let crmOrderNumber: string | null = null;
    let crmStatus: string | null = null;
    let crmError: string | null = null;
    const crmEnabled = process.env.CRM_SERVICE_ORDERS_ENABLED === 'true';
    if (crmEnabled && change.account.externalCrmId) {
      const labels = lookupDisconnectionLabels(
        change.disconnectionCategoryId,
        change.disconnectionSubCategoryId,
      );
      const samRef = `SAM-${change.id.slice(0, 8).toUpperCase()}`;
      const noteParts: string[] = [samRef];
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
          mailReceivedDate:
            change.mailReceivedDate?.toISOString().slice(0, 10) ?? undefined,
          notes: noteParts.join(' | '),
        });
        crmServiceOrderId = order.id;
        crmOrderNumber = order.orderNumber;
        crmStatus = order.status;
      } catch (err) {
        crmError =
          err instanceof CrmHttpError
            ? `CRM ${err.statusCode}: ${err.message}`
            : err instanceof Error
              ? err.message
              : 'CRM call failed';
        crmStatus = 'FAILED';
        // eslint-disable-next-line no-console
        console.warn(
          `[retentionDecision PROCEED ${commercialChangeId}] CRM service-order failed:`,
          crmError,
        );
      }
    }

    await prisma.$transaction([
      prisma.commercialChange.update({
        where: { id: commercialChangeId },
        data: {
          retentionDecision: 'PROCEED',
          retentionDecidedAt: decidedAt,
          scheduledTerminationAt: scheduledTermination,
          // crmStatus is set on both the success path ('PENDING_APPROVAL'/…)
          // and the failure path ('FAILED'). null is reserved for "didn't
          // even try" (kill-switch off / Excel-imported customer).
          ...(crmServiceOrderId
            ? { crmServiceOrderId, crmOrderNumber, crmStatus, crmStatusUpdatedAt: decidedAt }
            : crmStatus
              ? { crmStatus, crmStatusUpdatedAt: decidedAt }
              : {}),
        },
      }),
      prisma.account.update({
        where: { id: change.accountId },
        data: { contractStatus: 'DISCONNECTING' },
      }),
      prisma.auditLog.create({
        data: {
          entityType: 'CommercialChange',
          entityId: commercialChangeId,
          action: 'RETENTION_PROCEEDED',
          performedBy: performedByUserId,
          payload: {
            accountId: change.accountId,
            scheduledTerminationAt: scheduledTermination.toISOString(),
            crmServiceOrderId,
            crmOrderNumber,
            crmStatus,
            crmError,
          },
        },
      }),
    ]);

    return prisma.commercialChange.findUnique({ where: { id: commercialChangeId } });
  },
};

/**
 * Lazy-termination sweep. Called from any read path that needs an accurate
 * picture of contract status — e.g. dashboard metrics, customer lists, the
 * /probable-churn endpoint. Any DISCONNECTING row whose scheduledTerminationAt
 * has passed gets terminated via applyChangeToAccount (idempotent).
 *
 * Intentionally not a cron — running it on read keeps state convergence in a
 * single code path. The work is bounded (typically zero or a handful of rows
 * per call) and the existing accountAppliedAt marker prevents double-apply.
 *
 * Concurrency: PostgreSQL `FOR UPDATE SKIP LOCKED` ensures two simultaneous
 * dashboard reads can't both pick the same due row. Worker A locks rows {1,3}
 * and worker B sees only {2,4} — no overlap, no double-apply, no waiting on
 * each other. The lock releases at transaction commit (the implicit
 * autocommit on $queryRaw — fine here because applyChangeToAccount opens
 * its own transaction for the actual write).
 */
export async function sweepDueTerminations(): Promise<void> {
  const today = startOfDayUTC(new Date());
  // Raw query because Prisma's findMany has no native FOR UPDATE support
  // for this case. We only need the IDs — applyChangeToAccount re-reads
  // the row inside its own transaction and re-checks accountAppliedAt.
  const due = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id
      FROM commercial_changes
     WHERE change_type = 'DISCONNECTION'
       AND retention_decision = 'PROCEED'
       AND scheduled_termination_at <= ${today}
       AND account_applied_at IS NULL
     FOR UPDATE SKIP LOCKED
  `;
  for (const c of due) {
    await applyChangeToAccount(c.id);
  }
}

/**
 * Day 0 of a disconnection — flip the account to PROBABLE_CHURN and stamp
 * the day-21 prompt due date on the commercial-change row. Single transaction
 * so a crash mid-way can't strand half the state change.
 */
/**
 * Cancel the in-flight disconnection on an account when SAM commits a
 * non-disconnection commercial change against it. Surface usage: the Retain
 * button on the Probable Churn page deep-links into the rate-revision form
 * pre-filled with this customer; submitting that form lands here and the
 * pending disconnection is resolved as RETAIN.
 *
 * No-op if there's no pending disconnection. Re-uses RETAIN semantics so the
 * audit trail looks the same as a manual day-21 RETAIN.
 */
async function autoRetainPendingDisconnection(
  accountId: string,
  performedByUserId: string,
): Promise<void> {
  const pending = await prisma.commercialChange.findFirst({
    where: {
      accountId,
      changeType: 'DISCONNECTION',
      retentionDecision: null,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!pending) return;
  await prisma.$transaction([
    prisma.commercialChange.update({
      where: { id: pending.id },
      data: { retentionDecision: 'RETAIN', retentionDecidedAt: new Date() },
    }),
    prisma.account.update({
      where: { id: accountId },
      data: { contractStatus: 'ACTIVE' },
    }),
    prisma.auditLog.create({
      data: {
        entityType: 'CommercialChange',
        entityId: pending.id,
        action: 'RETENTION_RETAINED_AUTO',
        performedBy: performedByUserId,
        payload: {
          accountId,
          trigger: 'non-disconnection-commit-on-probable-churn',
        },
      },
    }),
  ]);
}

async function enterProbableChurn(commercialChangeId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const change = await tx.commercialChange.findUnique({
      where: { id: commercialChangeId },
    });
    if (!change) throw new Error('Commercial change not found');
    const prompt = startOfDayUTC(change.effectiveDate);
    prompt.setUTCDate(prompt.getUTCDate() + PROBABLE_CHURN_WINDOW_DAYS);
    await tx.commercialChange.update({
      where: { id: commercialChangeId },
      data: { retentionPromptDueAt: prompt },
    });
    await tx.account.update({
      where: { id: change.accountId },
      data: { contractStatus: 'PROBABLE_CHURN' },
    });
  });
}

/**
 * Push the quick-disconnect request to CRM's admin inbox. Best-effort —
 * failure does NOT roll back the SAM-side state. The account stays in
 * PENDING_QUICK_APPROVAL with an audit row stamped FAILED so an operator
 * can manually retry from the UI. CRM dedupes on eventId, so a retry with
 * a fresh eventId is fine (a future "retry" button will generate a new id).
 *
 * Contract: see CRM repo docs/integrations/sam-quick-disconnect-contract.md
 */
async function notifyCrmQuickDisconnectRequested(opts: {
  commercialChange: {
    id: string;
    newBandwidthMbps: number | null;
    quickRequestedDays: number | null;
    quickApprovalReason: string | null;
    disconnectionCategoryId: string | null;
    disconnectionSubCategoryId: string | null;
  };
  account: { externalCrmId: string | null; currentArc: Prisma.Decimal; currentPlan: string | null };
  performingUser: { id: string; email: string };
}): Promise<void> {
  const { commercialChange: cc, account, performingUser } = opts;

  // Excel-imported accounts have no CRM lead to push against — record that
  // and stop. SAM admin can hand off manually if needed.
  if (!account.externalCrmId) {
    await prisma.auditLog.create({
      data: {
        entityType: 'CommercialChange',
        entityId: cc.id,
        action: 'NOTIFY_CRM_QUICK_DISCONNECT_REQUESTED',
        performedBy: performingUser.id,
        payload: {
          outcome: 'SKIPPED',
          detail: 'Account has no externalCrmId (Excel-imported) — no CRM lead to push against.',
        },
      },
    });
    return;
  }

  // CRM requires the disconnection-reason taxonomy IDs so they can pre-
  // populate the resulting service order. The form enforces both as required
  // on commit; the `?? ''` fallback is defensive against legacy rows.
  const result = await pushQuickDisconnectRequest({
    commercialChangeId: cc.id,
    externalCrmId: account.externalCrmId,
    raisedBy: { id: performingUser.id, email: performingUser.email },
    reason: cc.quickApprovalReason ?? '(no reason provided)',
    disconnectionCategoryId: cc.disconnectionCategoryId ?? '',
    disconnectionSubCategoryId: cc.disconnectionSubCategoryId ?? '',
    requested: {
      arc: Number(account.currentArc),
      planName: account.currentPlan ?? undefined,
      bandwidth: cc.newBandwidthMbps ?? undefined,
      days: cc.quickRequestedDays ?? undefined,
    },
  });

  await prisma.auditLog.create({
    data: {
      entityType: 'CommercialChange',
      entityId: cc.id,
      action: 'NOTIFY_CRM_QUICK_DISCONNECT_REQUESTED',
      performedBy: performingUser.id,
      payload: result.ok
        ? {
            outcome: 'SENT',
            eventId: result.eventId,
            status: result.status,
            deduped: result.deduped ?? false,
          }
        : {
            outcome: 'FAILED',
            eventId: result.eventId,
            status: result.status,
            error: result.error,
            retriable: result.retriable,
          },
    },
  });
}

/**
 * Quick-disconnect entrypoint — flips the account to PENDING_QUICK_APPROVAL
 * and writes an audit-log entry so the CRM Admin's pending queue and the
 * SAM-side activity feed both have a record.
 *
 * No CRM service order is raised here. That happens later when the CRM
 * webhook arrives with `decision='APPROVE'` and we flip the account to
 * DISCONNECTING with `scheduledTerminationAt = approvedAt + quickRequestedDays`.
 */
async function enterPendingQuickApproval(commercialChangeId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const change = await tx.commercialChange.findUnique({
      where: { id: commercialChangeId },
    });
    if (!change) throw new Error('Commercial change not found');
    await tx.account.update({
      where: { id: change.accountId },
      data: { contractStatus: 'PENDING_QUICK_APPROVAL' },
    });
    await tx.auditLog.create({
      data: {
        entityType: 'CommercialChange',
        entityId: commercialChangeId,
        action: 'QUICK_DISCONNECT_REQUESTED',
        performedBy: change.createdBy,
        payload: {
          accountId: change.accountId,
          quickRequestedDays: change.quickRequestedDays,
          quickApprovalReason: change.quickApprovalReason,
        },
      },
    });
  });
}

function startOfDayUTC(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * Mirror a commercial change onto its account row. Idempotent via the
 * commercial_changes.account_applied_at marker — calling this twice on the
 * same row is a no-op the second time.
 *
 *  - UPGRADE / DOWNGRADE / RATE_REVISION → set currentArc + bandwidthMbps
 *  - DISCONNECTION                       → set contractStatus=TERMINATED + currentArc=0
 *
 * Wraps the account update + accountAppliedAt stamp in a single transaction
 * so a crash mid-way can't leave the account updated without the marker
 * (which would let a future refresh re-apply and double-update the account).
 */
async function applyChangeToAccount(commercialChangeId: string) {
  return prisma.$transaction(async (tx) => {
    const change = await tx.commercialChange.findUnique({
      where: { id: commercialChangeId },
    });
    if (!change) throw new Error('Commercial change not found');
    if (change.accountAppliedAt) return change; // already applied

    const isTermination = change.changeType === 'DISCONNECTION';
    const accountUpdate: Prisma.AccountUpdateInput = isTermination
      ? { contractStatus: 'TERMINATED', currentArc: 0 }
      : {
          currentArc: Number(change.newArc),
          ...(change.newBandwidthMbps != null
            ? { bandwidthMbps: change.newBandwidthMbps }
            : {}),
        };

    await tx.account.update({
      where: { id: change.accountId },
      data: accountUpdate,
    });

    return tx.commercialChange.update({
      where: { id: commercialChangeId },
      data: { accountAppliedAt: new Date() },
    });
  });
}

/** Map a SAM CommitInput → the CRM service-order request body. */
function buildServiceOrderInput(
  input: CommitInput,
  externalCrmId: string,
  samChangeId: string,
  approvalFileUrl: string | null,
  poFileUrl: string | null,
): CreateServiceOrderInput {
  const orderType: ServiceOrderType = input.changeType; // names already aligned post-rename
  const base: CreateServiceOrderInput = {
    customerId: externalCrmId,
    orderType,
  };
  // Cloudinary HTTPS URLs to the supporting documents — only included when
  // actually present, so the CRM doesn't get bogus empty-string URLs.
  if (approvalFileUrl) base.approvalFileUrl = approvalFileUrl;
  if (poFileUrl) base.poFileUrl = poFileUrl;
  // Mail-received date — date SAM got the customer's approval email. Passed
  // through so CRM can render it on their side. ISO date only, no time.
  if (input.mailReceivedDate) {
    base.mailReceivedDate = input.mailReceivedDate.toISOString().slice(0, 10);
  }
  // Always prefix CRM notes with our internal SAM-XXXXXXXX reference so
  // support tickets that span the boundary are trivially traceable. The
  // CRM team explicitly asked for this in their contract notes.
  const samRef = `SAM-${samChangeId.slice(0, 8).toUpperCase()}`;
  base.notes = input.notes ? `${samRef} | ${input.notes}` : samRef;

  if (orderType === 'DISCONNECTION') {
    if (!input.disconnectionCategoryId || !input.disconnectionSubCategoryId) {
      throw new Error(
        'disconnectionCategoryId and disconnectionSubCategoryId are required for DISCONNECTION',
      );
    }
    base.disconnectionCategoryId = input.disconnectionCategoryId;
    base.disconnectionSubCategoryId = input.disconnectionSubCategoryId;
    if (input.disconnectionReason) base.disconnectionReason = input.disconnectionReason;
    return base;
  }

  // UPGRADE / DOWNGRADE / RATE_REVISION — CRM expects ANNUAL ARC.
  base.newArc = Math.round(input.newArc);
  if (input.newBandwidthMbps != null) base.newBandwidth = input.newBandwidthMbps;
  base.effectiveDate = input.effectiveDate.toISOString();
  return base;
}
