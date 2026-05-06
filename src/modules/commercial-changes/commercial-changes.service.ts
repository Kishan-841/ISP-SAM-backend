import path from 'node:path';
import fs from 'node:fs/promises';
import type { CommercialChangeType, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { buildAccountsTeamDraft, type EmailDraft } from './notification-bridge.js';
import {
  getCrmClient,
  CrmHttpError,
  type CreateServiceOrderInput,
  type ServiceOrderType,
} from '../../services/integrations/crm/index.js';

export type Requester = { id: string; role: UserRole };

export type CommitInput = {
  accountId: string;
  changeType: CommercialChangeType;
  newMrr: number;
  newBandwidthMbps: number | null;
  effectiveDate: Date;
  reason: string | null;
  approvalFile: { buffer: Buffer; originalName: string };
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
    oldMrr: number;
    newMrr: number;
    effectiveDate: string;
    approvalFileUrl: string;
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

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');

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

    // 1. Persist the file to disk under uploads/<accountId>/
    const accountDir = path.join(UPLOADS_ROOT, input.accountId);
    await fs.mkdir(accountDir, { recursive: true });
    const safeName = input.approvalFile.originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${Date.now()}-${safeName}`;
    const fullPath = path.join(accountDir, filename);
    await fs.writeFile(fullPath, input.approvalFile.buffer);
    const relativeUrl = path.posix.join('uploads', input.accountId, filename);

    const oldMrr = Number(account.currentMrr);
    const oldBandwidth = account.bandwidthMbps ?? null;
    const isTermination = input.changeType === 'DISCONNECTION';

    // 2. Transaction: create commercial_change, update account, write audit log
    const result = await prisma.$transaction(async (tx) => {
      const change = await tx.commercialChange.create({
        data: {
          accountId: input.accountId,
          changeType: input.changeType,
          oldMrr,
          newMrr: input.newMrr,
          effectiveDate: input.effectiveDate,
          clientApprovalAttached: true,
          approvalFileUrl: relativeUrl,
          createdBy: input.performedByUserId,
          reason: input.reason,
          oldBandwidthMbps: oldBandwidth,
          newBandwidthMbps: input.newBandwidthMbps,
          disconnectionCategoryId: input.disconnectionCategoryId ?? null,
          disconnectionSubCategoryId: input.disconnectionSubCategoryId ?? null,
          disconnectionReason: input.disconnectionReason ?? null,
        },
      });

      const accountUpdate: Prisma.AccountUpdateInput = {
        currentMrr: input.newMrr,
        bandwidthMbps: input.newBandwidthMbps ?? account.bandwidthMbps,
      };
      if (isTermination) {
        accountUpdate.contractStatus = 'TERMINATED';
        accountUpdate.currentMrr = 0;
      }
      await tx.account.update({ where: { id: input.accountId }, data: accountUpdate });

      await tx.auditLog.create({
        data: {
          entityType: 'CommercialChange',
          entityId: change.id,
          action: 'COMMIT',
          performedBy: input.performedByUserId,
          payload: {
            accountId: input.accountId,
            changeType: input.changeType,
            oldMrr,
            newMrr: input.newMrr,
            effectiveDate: input.effectiveDate.toISOString(),
            approvalFileUrl: relativeUrl,
          },
        },
      });

      return change;
    });

    // 3. Forward to CRM as a service order (gated by CRM_SERVICE_ORDERS_ENABLED).
    //    CRM has the multi-team workflow (Docs → NOC → Accounts); SAM just
    //    fires the create. We persist the returned id + orderNumber + status
    //    onto the SAM row so the user can track progress and refresh.
    //
    //    NOTE: account.currentMrr was already updated optimistically above.
    //    If CRM rejects the order, the SAM row stays without crmServiceOrderId
    //    and the SAM operator can manually retry submission later (or undo
    //    via a fresh commercial change — Phase 2 work).
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
        const crmInput = buildServiceOrderInput(input, account.externalCrmId, result.id);
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
      oldMrr,
      newMrr: input.newMrr,
      effectiveDate: input.effectiveDate,
      reason: input.reason,
    });

    return {
      commercialChange: {
        id: result.id,
        accountId: result.accountId,
        changeType: result.changeType,
        oldMrr: Number(result.oldMrr),
        newMrr: Number(result.newMrr),
        effectiveDate: result.effectiveDate.toISOString(),
        approvalFileUrl: relativeUrl,
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
   */
  async refreshCrmStatus(commercialChangeId: string) {
    const change = await prisma.commercialChange.findUnique({
      where: { id: commercialChangeId },
      include: { account: { select: { externalCrmId: true } } },
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

    return prisma.commercialChange.update({
      where: { id: commercialChangeId },
      data: {
        crmStatus: order.status,
        crmStatusUpdatedAt: new Date(),
        activationDate: order.activationDate ? new Date(order.activationDate) : null,
      },
    });
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
    return prisma.commercialChange.update({
      where: { id: commercialChangeId },
      data: {
        crmStatus: order.status,
        crmStatusUpdatedAt: new Date(),
        activationDate,
      },
    });
  },
};

/** Map a SAM CommitInput → the CRM service-order request body. */
function buildServiceOrderInput(
  input: CommitInput,
  externalCrmId: string,
  samChangeId: string,
): CreateServiceOrderInput {
  const orderType: ServiceOrderType = input.changeType; // names already aligned post-rename
  const base: CreateServiceOrderInput = {
    customerId: externalCrmId,
    orderType,
  };
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

  // UPGRADE / DOWNGRADE / RATE_REVISION — CRM expects ANNUAL ARC, not monthly.
  base.newArc = Math.round(input.newMrr * 12);
  if (input.newBandwidthMbps != null) base.newBandwidth = input.newBandwidthMbps;
  base.effectiveDate = input.effectiveDate.toISOString();
  return base;
}
