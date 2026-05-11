import crypto from 'node:crypto';
import type { CommercialChangeType, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { buildAccountsTeamDraft, type EmailDraft } from './notification-bridge.js';
import {
  getCrmClient,
  CrmHttpError,
  type CreateServiceOrderInput,
  type ServiceOrderType,
} from '../../services/integrations/crm/index.js';
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
  /** Optional notes forwarded to CRM as `notes` on the service-order request. */
  notes?: string;
};

export type CommitResult = {
  commercialChange: {
    id: string;
    accountId: string;
    changeType: CommercialChangeType;
    oldArc: number;
    newArc: number;
    effectiveDate: string;
    approvalFileUrl: string | null;
    approvalFilePublicId: string | null;
    poFileUrl: string | null;
    poFilePublicId: string | null;
    crmServiceOrderId: string | null;
    crmOrderNumber: string | null;
    crmStatus: string | null;
  };
  emailDraft: EmailDraft;
  /** Outcome of the CRM service-order call. Null when the CRM bridge is disabled. */
  crm:
    | { ok: true; orderId: string; orderNumber: string; status: string }
    | { ok: false; error: string; status?: number }
    | { ok: 'disabled' };
};

export const commercialChangesService = {
  async commit(input: CommitInput): Promise<CommitResult> {
    const account = await prisma.account.findUnique({
      where: { id: input.accountId },
    });
    if (!account) {
      throw new Error('Account not found');
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

    if (!input.approvalFile && !input.poFile) {
      // Defensive — controller already gates this, but a service-level
      // guard keeps the rule honest if commit() is called from elsewhere.
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
          disconnectionCategoryId: input.disconnectionCategoryId ?? null,
          disconnectionSubCategoryId: input.disconnectionSubCategoryId ?? null,
          disconnectionReason: input.disconnectionReason ?? null,
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
          },
        },
      });

      return change;
    });

    // 3. Forward to CRM as a service order (gated by CRM_SERVICE_ORDERS_ENABLED).
    const crmEnabled = process.env.CRM_SERVICE_ORDERS_ENABLED === 'true';
    let crm: CommitResult['crm'];
    let crmServiceOrderId: string | null = null;
    let crmOrderNumber: string | null = null;
    let crmStatus: string | null = null;
    if (!crmEnabled) {
      crm = { ok: 'disabled' };
    } else if (!account.externalCrmId) {
      crm = {
        ok: false,
        error: 'Account has no externalCrmId — was it imported via the CRM webhook?',
      };
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
      effectiveDate: input.effectiveDate,
      samOwnerName: performingUser.name,
      reason: input.reason,
      performedByUserId: input.performedByUserId,
    });

    return {
      commercialChange: {
        id: result.id,
        accountId: result.accountId,
        changeType: result.changeType,
        oldArc: Number(result.oldArc),
        newArc: Number(result.newArc),
        effectiveDate: result.effectiveDate.toISOString(),
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
    if (updated.crmStatus === 'COMPLETED' && !updated.accountAppliedAt) {
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
};

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
