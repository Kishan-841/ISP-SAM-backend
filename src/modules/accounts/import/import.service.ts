import type { ContractStatus } from '@prisma/client';
import { prisma } from '../../../prisma.js';
import { deriveKittyType } from '../../../lib/kitty.js';
import { parseWorkbook, type ParsedRow } from './parse-workbook.js';

export type ImportSummary = {
  imported: number;
  updated: number;
  skipped: number;
  errors: { rowNumber: number; reason: string }[];
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
    const { rows, errors } = parseWorkbook(buffer);
    const summary: ImportSummary = { imported: 0, updated: 0, skipped: 0, errors: [...errors] };

    for (const row of rows) {
      const validation = validate(row);
      if ('error' in validation) {
        summary.errors.push({ rowNumber: row.rowNumber, reason: validation.error });
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
            await prisma.account.update({
              where: { id: existing.id },
              data: updateData,
            });
            summary.updated++;
            continue;
          }
        }
        await prisma.account.create({ data: { ...data } });
        summary.imported++;
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unknown DB error';
        summary.errors.push({ rowNumber: row.rowNumber, reason });
        summary.skipped++;
      }
    }
    return summary;
  },
};

type ValidatedData = {
  clientName: string;
  kittyType: 'BASE' | 'NEW';
  currentArc: number;
  startOfPeriodArc: number;
  contractStatus: ContractStatus;
  onboardingDate: Date;
  companyName?: string | null;
  mobileNumber?: string | null;
  leadId?: string | null;
  externalCrmId?: string | null;
  currentPlan?: string | null;
  bandwidthMbps?: number | null;
  metadata?: object;
};

function validate(row: ParsedRow): { error: string } | { data: ValidatedData } {
  const c = row.canonical;
  if (!c.clientName) return { error: 'Missing customer/client name' };
  if (!c.onboardingDate) return { error: 'Missing onboarding date' };
  if (typeof c.currentArc !== 'number') return { error: 'Missing ARC' };

  // contractStatus — accept aliases (e.g. "Closed" -> TERMINATED, "Live" -> ACTIVE).
  let status: ContractStatus = 'ACTIVE';
  if (c.contractStatus) {
    const normalized = c.contractStatus.toLowerCase().replace(/[^a-z]/g, '');
    const mapped = STATUS_ALIASES[normalized];
    if (!mapped) return { error: `Invalid contract status: ${c.contractStatus}` };
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
      leadId: c.leadId ?? null,
      externalCrmId: c.externalCrmId ?? null,
      currentPlan: c.currentPlan ?? null,
      bandwidthMbps: typeof c.bandwidthMbps === 'number' ? c.bandwidthMbps : null,
      metadata: Object.keys(row.metadata).length > 0 ? row.metadata : undefined,
    },
  };
}
