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

const ALLOWED_STATUSES: ContractStatus[] = ['ACTIVE', 'EXPIRED', 'TERMINATED', 'PENDING'];

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
            await prisma.account.update({
              where: { id: existing.id },
              data: { ...data },
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
  currentMrr: number;
  contractStatus: ContractStatus;
  onboardingDate: Date;
  companyName?: string | null;
  mobileNumber?: string | null;
  leadId?: string | null;
  externalCrmId?: string | null;
  currentPlan?: string | null;
  metadata?: object;
};

function validate(row: ParsedRow): { error: string } | { data: ValidatedData } {
  const c = row.canonical;
  if (!c.clientName) return { error: 'Missing customer/client name' };
  if (!c.onboardingDate) return { error: 'Missing onboarding date' };

  // currentMrr: prefer explicit MRR, else compute from ARC ÷ 12
  let mrr: number | null = null;
  if (typeof c.currentMrr === 'number') mrr = c.currentMrr;
  else if (typeof c.currentArc === 'number') mrr = c.currentArc / 12;
  if (mrr === null) return { error: 'Missing MRR/ARC' };

  // contractStatus
  let status: ContractStatus = 'ACTIVE';
  if (c.contractStatus) {
    const upper = c.contractStatus.toUpperCase();
    if (!(ALLOWED_STATUSES as string[]).includes(upper)) {
      return { error: `Invalid contract status: ${c.contractStatus}` };
    }
    status = upper as ContractStatus;
  }

  return {
    data: {
      clientName: c.clientName,
      kittyType: deriveKittyType(c.onboardingDate),
      currentMrr: mrr,
      contractStatus: status,
      onboardingDate: c.onboardingDate,
      companyName: c.companyName ?? null,
      mobileNumber: c.mobileNumber ?? null,
      leadId: c.leadId ?? null,
      externalCrmId: c.externalCrmId ?? null,
      currentPlan: c.currentPlan ?? null,
      metadata: Object.keys(row.metadata).length > 0 ? row.metadata : undefined,
    },
  };
}
