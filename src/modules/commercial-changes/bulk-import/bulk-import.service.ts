import { Prisma } from '@prisma/client';
import { prisma } from '../../../prisma.js';
import { parseWorkbook, type ParsedRow } from './parse-workbook.js';
import { DISCONNECTION_REASONS } from '../disconnection-reasons.js';

export type BulkImportErrorKind =
  | 'missing_field'
  | 'invalid_value'
  | 'unknown_circuit'
  | 'inconsistent_arc'
  | 'invalid_disconnection_reason'
  | 'account_terminated'
  | 'other';

export type BulkImportError = {
  rowNumber: number;
  reason: string;
  kind: BulkImportErrorKind;
  circuitId?: string | null;
  changeType?: string | null;
};

export type BulkImportedRowPreview = {
  rowNumber: number;
  circuitId: string;
  clientName: string;
  changeType: 'UPGRADE' | 'DOWNGRADE' | 'RATE_REVISION' | 'DISCONNECTION';
  oldArc: number;
  newArc: number;
  effectiveDate: string;
};

export type BulkImportSummary = {
  imported: number;
  skipped: number;
  appliedChanges: BulkImportedRowPreview[];
  errors: BulkImportError[];
};

type AllowedChangeType = BulkImportedRowPreview['changeType'];
const ALLOWED_CHANGE_TYPES: ReadonlySet<AllowedChangeType> = new Set([
  'UPGRADE',
  'DOWNGRADE',
  'RATE_REVISION',
  'DISCONNECTION',
]);

// Flatten the disconnection-reason taxonomy. The Excel takes either a
// sub-category id (preferred, more specific) or a top-level category id —
// both resolve to a valid commit. The actual labels are looked up at apply
// time via `lookupDisconnectionLabels()` to keep the audit row readable.
const VALID_DISCONNECTION_CODES = new Set<string>([
  ...DISCONNECTION_REASONS.map((c) => c.id),
  ...DISCONNECTION_REASONS.flatMap((c) => c.subCategories.map((s) => s.id)),
]);

/**
 * Bulk commercial-change importer (ADMIN-only at the route layer).
 *
 * Design notes — read these before touching this file:
 *
 *  1. **No CRM round-trip.** Every applied row is treated as already-completed
 *     in the source-of-truth system (CRM). The change row is stamped with
 *     `crmStatus = 'BULK_LOCAL'` and `accountAppliedAt = effectiveDate` so the
 *     dashboard waterfall counts it immediately. Same pattern as
 *     `backfillDisconnection`.
 *
 *  2. **No document gate.** Normal commits require at least one of approval /
 *     PO. The bulk path runs without files — the audit row records the
 *     admin + IP + UA, which is the evidence trail we accept for bulk
 *     operations (matches `backfill-disconnection`).
 *
 *  3. **Partial success.** A bad row doesn't abort the batch. Valid rows
 *     commit; invalid rows are collected into `errors[]` and surfaced to the
 *     UI. Mirrors the accounts excel-import behavior so the operator's
 *     mental model is consistent.
 *
 *  4. **One transaction per row.** Each applied row is its own transaction:
 *     commercial-change insert + account update + audit row, all-or-nothing.
 *     But the batch as a whole is NOT transactional — see point 3.
 */
export const bulkImportService = {
  async importWorkbook(opts: {
    buffer: Buffer;
    performedByUserId: string;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<BulkImportSummary> {
    const { rows, errors: parseErrors } = parseWorkbook(opts.buffer);
    const summary: BulkImportSummary = {
      imported: 0,
      skipped: parseErrors.length,
      appliedChanges: [],
      errors: parseErrors.map((e) => ({
        rowNumber: e.rowNumber,
        reason: e.reason,
        kind: 'invalid_value' as const,
      })),
    };

    // Pre-load all circuit ids referenced by the workbook in one query.
    // Cheaper than per-row lookup and lets us emit unknown-circuit errors
    // without partial commits.
    const circuitIds = Array.from(
      new Set(
        rows
          .map((r) => r.canonical.circuitId?.trim())
          .filter((s): s is string => Boolean(s)),
      ),
    );
    const accountsByCircuit = new Map<
      string,
      {
        id: string;
        clientName: string;
        circuitId: string;
        currentArc: Prisma.Decimal;
        bandwidthMbps: number | null;
        contractStatus: string;
      }
    >();
    if (circuitIds.length > 0) {
      const found = await prisma.account.findMany({
        where: { circuitId: { in: circuitIds } },
        select: {
          id: true,
          clientName: true,
          circuitId: true,
          currentArc: true,
          bandwidthMbps: true,
          contractStatus: true,
        },
      });
      for (const a of found) {
        if (a.circuitId) {
          accountsByCircuit.set(a.circuitId, {
            id: a.id,
            clientName: a.clientName,
            circuitId: a.circuitId,
            currentArc: a.currentArc,
            bandwidthMbps: a.bandwidthMbps,
            contractStatus: a.contractStatus,
          });
        }
      }
    }

    for (const row of rows) {
      const validation = validateRow(row, accountsByCircuit);
      if ('error' in validation) {
        summary.errors.push({
          rowNumber: row.rowNumber,
          reason: validation.error,
          kind: validation.kind,
          circuitId: row.canonical.circuitId ?? null,
          changeType: row.canonical.changeType ?? null,
        });
        summary.skipped++;
        continue;
      }
      try {
        const applied = await applyRow(validation, {
          performedByUserId: opts.performedByUserId,
          ipAddress: opts.ipAddress,
          userAgent: opts.userAgent,
        });
        summary.appliedChanges.push({
          rowNumber: row.rowNumber,
          circuitId: validation.account.circuitId,
          clientName: validation.account.clientName,
          changeType: validation.changeType,
          oldArc: Number(validation.account.currentArc),
          newArc: validation.newArc,
          effectiveDate: applied.effectiveDate.toISOString().slice(0, 10),
        });
        summary.imported++;
      } catch (err) {
        summary.errors.push({
          rowNumber: row.rowNumber,
          reason: `Apply failed: ${err instanceof Error ? err.message : String(err)}`,
          kind: 'other',
          circuitId: row.canonical.circuitId ?? null,
          changeType: row.canonical.changeType ?? null,
        });
        summary.skipped++;
      }
    }

    return summary;
  },
};

type ValidatedRow = {
  rowNumber: number;
  changeType: AllowedChangeType;
  newArc: number;
  newBandwidthMbps: number | null;
  effectiveDate: Date;
  mailReceivedDate: Date | null;
  disconnectionReason: string | null;
  reason: string | null;
  account: {
    id: string;
    clientName: string;
    circuitId: string;
    currentArc: Prisma.Decimal;
    bandwidthMbps: number | null;
    contractStatus: string;
  };
};

type ValidationError = { error: string; kind: BulkImportErrorKind };

function validateRow(
  row: ParsedRow,
  accountsByCircuit: Map<string, {
    id: string;
    clientName: string;
    circuitId: string;
    currentArc: Prisma.Decimal;
    bandwidthMbps: number | null;
    contractStatus: string;
  }>,
): ValidatedRow | ValidationError {
  const c = row.canonical;
  if (!c.circuitId) {
    return { error: 'Missing circuitId', kind: 'missing_field' };
  }
  const account = accountsByCircuit.get(c.circuitId.trim());
  if (!account) {
    return {
      error: `No account found with circuit_id "${c.circuitId}"`,
      kind: 'unknown_circuit',
    };
  }
  if (!c.changeType) {
    return { error: 'Missing changeType', kind: 'missing_field' };
  }
  const ct = c.changeType.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!ALLOWED_CHANGE_TYPES.has(ct as AllowedChangeType)) {
    return {
      error: `Invalid changeType "${c.changeType}" — must be one of UPGRADE / DOWNGRADE / RATE_REVISION / DISCONNECTION`,
      kind: 'invalid_value',
    };
  }
  const changeType = ct as AllowedChangeType;

  if (!c.effectiveDate) {
    return { error: 'Missing effectiveDate', kind: 'missing_field' };
  }

  // Block re-applying to an already-terminated account. Same guard as
  // backfillDisconnection — keeps the dashboard from double-counting.
  if (account.contractStatus === 'TERMINATED') {
    return {
      error: `Account already TERMINATED — cannot apply ${changeType} on top`,
      kind: 'account_terminated',
    };
  }

  const oldArc = Number(account.currentArc);
  let newArc: number;
  if (changeType === 'DISCONNECTION') {
    newArc = 0;
  } else {
    if (c.newArc == null || !Number.isFinite(c.newArc)) {
      return { error: `${changeType} requires newArc`, kind: 'missing_field' };
    }
    if (c.newArc < 0) {
      return { error: 'newArc must be non-negative', kind: 'invalid_value' };
    }
    newArc = c.newArc;
  }

  // Per-type ARC consistency checks. These mirror the per-row form's
  // validation so bulk-imported rows can't slip past business rules:
  //   - UPGRADE  newArc must be strictly greater than current
  //   - DOWNGRADE newArc must be strictly less than current
  //   - RATE_REVISION newArc must equal current (it's a bandwidth-only change)
  if (changeType === 'UPGRADE' && newArc <= oldArc) {
    return {
      error: `UPGRADE newArc (${newArc}) must be greater than current ARC (${oldArc})`,
      kind: 'inconsistent_arc',
    };
  }
  if (changeType === 'DOWNGRADE' && newArc >= oldArc) {
    return {
      error: `DOWNGRADE newArc (${newArc}) must be less than current ARC (${oldArc})`,
      kind: 'inconsistent_arc',
    };
  }
  if (changeType === 'RATE_REVISION' && newArc !== oldArc) {
    return {
      error: `RATE_REVISION newArc (${newArc}) must equal current ARC (${oldArc}) — only bandwidth changes`,
      kind: 'inconsistent_arc',
    };
  }

  if (changeType === 'DISCONNECTION') {
    // disconnectionReason is OPTIONAL on the bulk path — the per-row form
    // still requires it because the SAM is making the decision interactively,
    // but bulk imports typically come from historical exports where the
    // reason field may be blank. When present, the value must still match
    // a canonical code; when absent, the row commits with reason = null.
    if (
      c.disconnectionReason &&
      !VALID_DISCONNECTION_CODES.has(c.disconnectionReason.trim())
    ) {
      return {
        error: `Invalid disconnection reason "${c.disconnectionReason}" — must match a code from /commercial-changes/disconnection-reasons`,
        kind: 'invalid_disconnection_reason',
      };
    }
  }

  return {
    rowNumber: row.rowNumber,
    changeType,
    newArc,
    newBandwidthMbps:
      c.newBandwidthMbps != null && Number.isFinite(c.newBandwidthMbps)
        ? Math.round(c.newBandwidthMbps)
        : null,
    effectiveDate: c.effectiveDate,
    mailReceivedDate: c.mailReceivedDate ?? null,
    disconnectionReason: c.disconnectionReason?.trim() ?? null,
    reason: c.reason?.trim() ?? null,
    account,
  };
}

async function applyRow(
  v: ValidatedRow,
  ctx: {
    performedByUserId: string;
    ipAddress: string | null;
    userAgent: string | null;
  },
): Promise<{ effectiveDate: Date }> {
  const effectiveDate = startOfDayUTC(v.effectiveDate);
  const oldArc = Number(v.account.currentArc);
  const oldBandwidth = v.account.bandwidthMbps;

  await prisma.$transaction(async (tx) => {
    // 1. Write the commercial-change row, fully stamped as if the entire
    //    workflow had already completed.
    const change = await tx.commercialChange.create({
      data: {
        accountId: v.account.id,
        changeType: v.changeType,
        oldArc,
        newArc: v.newArc,
        oldBandwidthMbps: oldBandwidth,
        newBandwidthMbps: v.newBandwidthMbps ?? oldBandwidth,
        effectiveDate,
        mailReceivedDate: v.mailReceivedDate ?? null,
        clientApprovalAttached: false,
        createdBy: ctx.performedByUserId,
        reason: v.reason ?? null,
        disconnectionReason:
          v.changeType === 'DISCONNECTION' ? v.disconnectionReason : null,
        disconnectionMode: v.changeType === 'DISCONNECTION' ? 'NORMAL' : null,
        retentionPromptDueAt:
          v.changeType === 'DISCONNECTION' ? effectiveDate : null,
        retentionDecision:
          v.changeType === 'DISCONNECTION' ? 'PROCEED' : null,
        retentionDecidedAt:
          v.changeType === 'DISCONNECTION' ? effectiveDate : null,
        scheduledTerminationAt:
          v.changeType === 'DISCONNECTION' ? effectiveDate : null,
        accountAppliedAt: effectiveDate,
        crmStatus: 'BULK_LOCAL',
        crmStatusUpdatedAt: new Date(),
        activationDate: effectiveDate,
      },
    });

    // 2. Apply to the account. DISCONNECTION zeros out currentArc and sets
    //    TERMINATED. Everything else just bumps currentArc + bandwidth.
    if (v.changeType === 'DISCONNECTION') {
      await tx.account.update({
        where: { id: v.account.id },
        data: { contractStatus: 'TERMINATED', currentArc: 0 },
      });
    } else {
      await tx.account.update({
        where: { id: v.account.id },
        data: {
          currentArc: v.newArc,
          ...(v.newBandwidthMbps != null
            ? { bandwidthMbps: v.newBandwidthMbps }
            : {}),
        },
      });
    }

    // 3. Audit trail — captures admin + IP + UA + which row in which sheet.
    await tx.auditLog.create({
      data: {
        entityType: 'CommercialChange',
        entityId: change.id,
        action: 'BULK_IMPORT_COMMERCIAL_CHANGE',
        performedBy: ctx.performedByUserId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        payload: {
          accountId: v.account.id,
          circuitId: v.account.circuitId,
          clientName: v.account.clientName,
          changeType: v.changeType,
          oldArc,
          newArc: v.newArc,
          oldBandwidthMbps: oldBandwidth,
          newBandwidthMbps: v.newBandwidthMbps ?? oldBandwidth,
          effectiveDate: effectiveDate.toISOString().slice(0, 10),
          rowNumber: v.rowNumber,
          source: 'BULK_EXCEL',
          note: 'Bulk-imported commercial change — no CRM service-order raised, no document attached.',
        },
      },
    });
  });

  return { effectiveDate };
}

function startOfDayUTC(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}
