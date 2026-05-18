import { Prisma, type ContractStatus, type KittyType } from '@prisma/client';
import { prisma } from '../../../prisma.js';
import { deriveKittyType } from '../../../lib/kitty.js';
import { parseWorkbook, type ParsedRow } from './parse-workbook.js';

/**
 * Compact account preview returned to the UI so users can immediately see
 * *which* rows from their workbook landed in the system, with the same
 * fields they'll then verify on /customers. Kept narrow on purpose — this
 * is for an immediate post-upload sanity check, not a full account view.
 */
export type ImportedAccountPreview = {
  /** 1-indexed row number from the workbook (header is row 1). */
  rowNumber: number;
  accountId: string;
  clientName: string;
  companyName: string | null;
  leadId: string | null;
  externalCrmId: string | null;
  email: string | null;
  currentArc: number;
  kittyType: KittyType;
  contractStatus: ContractStatus;
};

/**
 * Categorised reason for why a row was rejected — lets the UI render a
 * tone-appropriate chip ("missing field" amber vs. "duplicate" red).
 * Falls back to `'other'` for anything we don't specifically classify.
 */
export type ImportErrorKind =
  | 'missing_field'
  | 'invalid_value'
  | 'duplicate'
  | 'other';

export type ImportError = {
  rowNumber: number;
  reason: string;
  kind: ImportErrorKind;
  /** Best-effort name/lead pulled from the offending row for context. */
  clientName?: string | null;
  leadId?: string | null;
};

export type ImportSummary = {
  imported: number;
  updated: number;
  skipped: number;
  createdAccounts: ImportedAccountPreview[];
  updatedAccounts: ImportedAccountPreview[];
  errors: ImportError[];
};

const STATUS_ALIASES: Record<string, ContractStatus> = {
  active: 'ACTIVE',
  live: 'ACTIVE',
  inservice: 'ACTIVE',
  pending: 'PENDING',
  new: 'PENDING',
  inprogress: 'PENDING',
  expired: 'EXPIRED',
  suspended: 'EXPIRED',
  paused: 'EXPIRED',
  terminated: 'TERMINATED',
  closed: 'TERMINATED',
  disconnected: 'TERMINATED',
  cancelled: 'TERMINATED',
  canceled: 'TERMINATED',
  churned: 'TERMINATED',
};

export const importService = {
  async importWorkbook(buffer: Buffer): Promise<ImportSummary> {
    const { rows, errors: parseErrors } = parseWorkbook(buffer);
    const summary: ImportSummary = {
      imported: 0,
      updated: 0,
      skipped: 0,
      createdAccounts: [],
      updatedAccounts: [],
      // Parse-time errors (bad number/date) come through pre-categorised as
      // invalid_value — they're shape problems, not missing fields.
      errors: parseErrors.map((e) => ({
        rowNumber: e.rowNumber,
        reason: e.reason,
        kind: 'invalid_value' as const,
      })),
    };

    for (const row of rows) {
      const validation = validate(row);
      if ('error' in validation) {
        summary.errors.push({
          rowNumber: row.rowNumber,
          reason: validation.error,
          kind: validation.kind,
          clientName: row.canonical.clientName ?? null,
          leadId: row.canonical.leadId ?? null,
        });
        summary.skipped++;
        continue;
      }
      const data = validation.data;

      try {
        // Idempotency: leadId first, then externalCrmId
        const dedupKey =
          data.leadId ? { leadId: data.leadId } :
          data.externalCrmId ? { externalCrmId: data.externalCrmId } :
          null;

        if (dedupKey) {
          const existing = await prisma.account.findFirst({ where: dedupKey });
          if (existing) {
            // On update path: don't overwrite startOfPeriodArc (it's a snapshot
            // at first-import time and the dashboard waterfall reads it).
            const { startOfPeriodArc: _ignored, ...updateData } = data;
            const updated = await prisma.account.update({
              where: { id: existing.id },
              data: updateData,
              select: previewSelect,
            });
            summary.updated++;
            summary.updatedAccounts.push(toPreview(row.rowNumber, updated));
            continue;
          }
        }
        const created = await prisma.account.create({
          data: { ...data },
          select: previewSelect,
        });
        summary.imported++;
        summary.createdAccounts.push(toPreview(row.rowNumber, created));
      } catch (err) {
        const { reason, kind } = describeDbError(err);
        summary.errors.push({
          rowNumber: row.rowNumber,
          reason,
          kind,
          clientName: row.canonical.clientName ?? null,
          leadId: row.canonical.leadId ?? null,
        });
        summary.skipped++;
      }
    }
    return summary;
  },
};

const previewSelect = {
  id: true,
  clientName: true,
  companyName: true,
  leadId: true,
  externalCrmId: true,
  email: true,
  currentArc: true,
  kittyType: true,
  contractStatus: true,
} as const;

type PreviewRow = {
  id: string;
  clientName: string;
  companyName: string | null;
  leadId: string | null;
  externalCrmId: string | null;
  email: string | null;
  currentArc: Prisma.Decimal;
  kittyType: KittyType;
  contractStatus: ContractStatus;
};

function toPreview(rowNumber: number, a: PreviewRow): ImportedAccountPreview {
  return {
    rowNumber,
    accountId: a.id,
    clientName: a.clientName,
    companyName: a.companyName,
    leadId: a.leadId,
    externalCrmId: a.externalCrmId,
    email: a.email,
    currentArc: Number(a.currentArc),
    kittyType: a.kittyType,
    contractStatus: a.contractStatus,
  };
}

function describeDbError(err: unknown): { reason: string; kind: ImportErrorKind } {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = (err.meta?.target ?? []) as string[] | string;
    const fields = Array.isArray(target) ? target : [String(target)];
    const fieldList = fields.join(', ');
    return {
      reason: `Duplicate value on unique field(s): ${fieldList}. A row with this value already exists.`,
      kind: 'duplicate',
    };
  }
  if (err instanceof Error) return { reason: err.message, kind: 'other' };
  return { reason: 'Unknown DB error', kind: 'other' };
}

type ValidatedData = {
  clientName: string;
  kittyType: 'BASE' | 'NEW';
  currentArc: number;
  startOfPeriodArc: number;
  contractStatus: ContractStatus;
  onboardingDate: Date;
  companyName?: string | null;
  mobileNumber?: string | null;
  email?: string | null;
  leadId?: string | null;
  externalCrmId?: string | null;
  currentPlan?: string | null;
  bandwidthMbps?: number | null;
  metadata?: object;
};

function validate(
  row: ParsedRow,
): { error: string; kind: ImportErrorKind } | { data: ValidatedData } {
  const c = row.canonical;
  if (!c.clientName) return { error: 'Missing customer/client name', kind: 'missing_field' };
  if (!c.onboardingDate) return { error: 'Missing onboarding date', kind: 'missing_field' };
  if (typeof c.currentArc !== 'number') return { error: 'Missing ARC', kind: 'missing_field' };

  // contractStatus — accept aliases (e.g. "Closed" -> TERMINATED, "Live" -> ACTIVE).
  let status: ContractStatus = 'ACTIVE';
  if (c.contractStatus) {
    const normalized = c.contractStatus.toLowerCase().replace(/[^a-z]/g, '');
    const mapped = STATUS_ALIASES[normalized];
    if (!mapped) {
      return { error: `Invalid contract status: ${c.contractStatus}`, kind: 'invalid_value' };
    }
    status = mapped;
  }

  return {
    data: {
      clientName: c.clientName,
      kittyType: deriveKittyType(c.onboardingDate),
      currentArc: c.currentArc,
      // Snapshot at create-time. The update path strips this so re-imports
      // don't overwrite the original baseline.
      startOfPeriodArc: c.currentArc,
      contractStatus: status,
      onboardingDate: c.onboardingDate,
      companyName: c.companyName ?? null,
      mobileNumber: c.mobileNumber ?? null,
      email: c.email?.trim() || null,
      leadId: c.leadId ?? null,
      externalCrmId: c.externalCrmId ?? null,
      currentPlan: c.currentPlan ?? null,
      bandwidthMbps: typeof c.bandwidthMbps === 'number' ? c.bandwidthMbps : null,
      metadata: Object.keys(row.metadata).length > 0 ? row.metadata : undefined,
    },
  };
}
