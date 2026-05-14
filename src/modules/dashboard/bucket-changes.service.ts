import type { CommercialChangeType, KittyType, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { fyQuarterRange, type FyQuarter } from './dashboard.service.js';

export type Requester = { id: string; role: UserRole };

export type BucketChangeRow = {
  id: string;
  effectiveDate: string;
  mailReceivedDate: string | null;
  customer: {
    id: string;
    clientName: string;
    companyName: string | null;
    customerCode: string | null;
    circuitId: string | null;
    kittyType: KittyType;
    /** null = Excel-imported / not CRM-synced — UI hides CRM-only details. */
    externalCrmId: string | null;
  };
  samOwner: { id: string; name: string; email: string } | null;
  changeType: CommercialChangeType;
  oldArc: number;
  newArc: number;
  deltaArc: number;
  oldBandwidthMbps: number | null;
  newBandwidthMbps: number | null;
  reason: string | null;
  disconnectionReason: string | null;
  approvalFileUrl: string | null;
  poFileUrl: string | null;
  crmStatus: string | null;
};

/**
 * Drill-down behind the four commercial-change bucket cards on the
 * Existing Base / New Base dashboards. Returns the underlying rows that
 * contributed to the count + ARC delta the card displays.
 *
 * Filters mirror the parent dashboard endpoint exactly:
 *  - kittyType pins the account scope (BASE for Existing Base, NEW for New Base).
 *  - quarter narrows by effective_date when kittyType=BASE (matches existingBase).
 *    Ignored for NEW (computeNewBase aggregates all-time, so does the drill-down).
 *
 * Role scoping mirrors commercial-changes.service.ts:list — SAMs see only their
 * own accounts; SAM_HEAD/ADMIN see everything. Aligns with /transactions, which
 * is where the cards used to navigate.
 */
export async function getBucketChanges(opts: {
  kittyType: KittyType;
  bucket: CommercialChangeType;
  quarter?: FyQuarter;
  requester: Requester;
}): Promise<{ changes: BucketChangeRow[] }> {
  const accountWhere: Prisma.AccountWhereInput = { kittyType: opts.kittyType };
  if (opts.requester.role === 'SAM') {
    accountWhere.samOwnerId = opts.requester.id;
  }

  const where: Prisma.CommercialChangeWhereInput = {
    changeType: opts.bucket,
    account: accountWhere,
  };

  // Quarter window only applies to BASE — matches dashboard.service.ts:existingBase.
  if (opts.quarter && opts.kittyType === 'BASE') {
    const { start, end } = fyQuarterRange(opts.quarter);
    where.effectiveDate = { gte: start, lte: end };
  }

  const rows = await prisma.commercialChange.findMany({
    where,
    include: {
      account: {
        select: {
          id: true,
          clientName: true,
          companyName: true,
          customerCode: true,
          circuitId: true,
          kittyType: true,
          externalCrmId: true,
          samOwner: { select: { id: true, name: true, email: true } },
        },
      },
    },
    orderBy: [{ effectiveDate: 'desc' }, { id: 'desc' }],
  });

  const changes: BucketChangeRow[] = rows.map((r) => {
    const oldArc = Number(r.oldArc);
    const newArc = Number(r.newArc);
    return {
      id: r.id,
      effectiveDate: r.effectiveDate.toISOString(),
      mailReceivedDate: r.mailReceivedDate?.toISOString() ?? null,
      customer: {
        id: r.account.id,
        clientName: r.account.clientName,
        companyName: r.account.companyName,
        customerCode: r.account.customerCode,
        circuitId: r.account.circuitId,
        kittyType: r.account.kittyType,
        externalCrmId: r.account.externalCrmId,
      },
      samOwner: r.account.samOwner
        ? {
            id: r.account.samOwner.id,
            name: r.account.samOwner.name,
            email: r.account.samOwner.email,
          }
        : null,
      changeType: r.changeType,
      oldArc,
      newArc,
      // Signed Δ. Disconnections become negative because newArc=0.
      // Rate revisions are typically 0 (same ARC, bandwidth changes).
      deltaArc: newArc - oldArc,
      oldBandwidthMbps: r.oldBandwidthMbps,
      newBandwidthMbps: r.newBandwidthMbps,
      reason: r.reason,
      disconnectionReason: r.disconnectionReason,
      approvalFileUrl: r.approvalFileUrl,
      poFileUrl: r.poFileUrl,
      crmStatus: r.crmStatus,
    };
  });

  return { changes };
}
