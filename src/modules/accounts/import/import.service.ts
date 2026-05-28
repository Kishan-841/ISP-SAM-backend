import { Prisma, type ContractStatus, type KittyType } from '@prisma/client';
import { prisma } from '../../../prisma.js';
import { deriveKittyType } from '../../../lib/kitty.js';
import { parseWorkbook, type ParsedRow } from './parse-workbook.js';
import type { CanonicalRow } from './header-map.js';

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
  circuitId: string | null;
  customerCode: string | null;
  address: string | null;
  /** Resolved SAM display name (from the user table), or null if no match. */
  samOwnerName: string | null;
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
  | 'warning'
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
  // Common Indian-spreadsheet spelling of "no longer active" — service
  // has stopped, so treat as TERMINATED rather than EXPIRED (which implies
  // the contract ran its term).
  deactive: 'TERMINATED',
  inactive: 'TERMINATED',
  notactive: 'TERMINATED',
  stopped: 'TERMINATED',
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

    // Pre-load the SAM directory once so per-row resolution is O(1).
    const samDirectory = await loadSamDirectory();

    for (const row of rows) {
      const validation = validate(row, samDirectory);
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
      const { data, samOwnerName, warning } = validation;
      if (warning) {
        // Non-blocking — row still imports, but the UI surfaces the issue
        // so the user can fix the SAM column and re-run.
        summary.errors.push({
          rowNumber: row.rowNumber,
          reason: warning,
          kind: 'warning',
          clientName: row.canonical.clientName ?? null,
          leadId: row.canonical.leadId ?? null,
        });
      }

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
            summary.updatedAccounts.push(toPreview(row.rowNumber, updated, samOwnerName));
            continue;
          }
        }
        const created = await prisma.account.create({
          data: { ...data },
          select: previewSelect,
        });
        summary.imported++;
        summary.createdAccounts.push(toPreview(row.rowNumber, created, samOwnerName));
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
  circuitId: true,
  customerCode: true,
  address: true,
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
  circuitId: string | null;
  customerCode: string | null;
  address: string | null;
};

function toPreview(
  rowNumber: number,
  a: PreviewRow,
  samOwnerName: string | null,
): ImportedAccountPreview {
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
    circuitId: a.circuitId,
    customerCode: a.customerCode,
    address: a.address,
    samOwnerName,
  };
}

/**
 * In-memory directory of SAM-eligible users (ADMIN / SAM_HEAD / SAM all
 * count) so import can map an Excel `sam` column — either email or name —
 * to a user id without per-row DB lookups.
 *
 * Matching strategy in `resolveSam`:
 *  1. Email lookup (case-insensitive, unique).
 *  2. Exact full-name match (case-insensitive). Ambiguous if 2+ users share a name.
 *  3. First-name fallback: if Excel says "Mangesh" and exactly ONE user's
 *     name starts with "mangesh ", auto-assign. Two or more candidates →
 *     ambiguous warning, imported unassigned.
 */
type SamUser = { id: string; name: string };
type SamDirectory = {
  byEmail: Map<string, SamUser>;
  byName: Map<string, { id: string; name: string; ambiguous: boolean }>;
  allUsers: SamUser[];
};

async function loadSamDirectory(): Promise<SamDirectory> {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true },
  });
  const byEmail = new Map<string, SamUser>();
  const byName = new Map<string, { id: string; name: string; ambiguous: boolean }>();
  for (const u of users) {
    byEmail.set(u.email.toLowerCase(), { id: u.id, name: u.name });
    const key = u.name.trim().toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      byName.set(key, { ...existing, ambiguous: true });
    } else {
      byName.set(key, { id: u.id, name: u.name, ambiguous: false });
    }
  }
  return {
    byEmail,
    byName,
    allUsers: users.map((u) => ({ id: u.id, name: u.name })),
  };
}

/**
 * Find users whose first name (first whitespace-delimited token of their
 * full name) matches `firstName`. Case-insensitive. Used to allow Excel
 * sheets to identify a SAM by just "Mangesh" when the DB row is
 * "Mangesh Fulbandhe".
 */
function findByFirstName(directory: SamDirectory, firstName: string): SamUser[] {
  const target = firstName.toLowerCase();
  const matches: SamUser[] = [];
  for (const u of directory.allUsers) {
    const first = u.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (first === target) matches.push(u);
  }
  return matches;
}

function resolveSam(
  canonical: CanonicalRow,
  directory: SamDirectory,
): { samOwnerId: string | null; samOwnerName: string | null; warning: string | null } {
  const email = canonical.samEmail?.trim().toLowerCase();
  if (email) {
    const hit = directory.byEmail.get(email);
    if (hit) return { samOwnerId: hit.id, samOwnerName: hit.name, warning: null };
    return {
      samOwnerId: null,
      samOwnerName: null,
      warning: `SAM email "${canonical.samEmail}" did not match any user. Imported as unassigned.`,
    };
  }
  const rawName = canonical.samName?.trim();
  if (!rawName) return { samOwnerId: null, samOwnerName: null, warning: null };

  // 1. Exact full-name match.
  const lower = rawName.toLowerCase();
  const exact = directory.byName.get(lower);
  if (exact) {
    if (exact.ambiguous) {
      return {
        samOwnerId: null,
        samOwnerName: null,
        warning: `SAM name "${rawName}" matched multiple users with that exact full name — please use the SAM's email instead. Imported as unassigned.`,
      };
    }
    return { samOwnerId: exact.id, samOwnerName: exact.name, warning: null };
  }

  // 2. First-name fallback. Only meaningful when the Excel value is a
  //    single token — once the operator wrote two tokens ("Mangesh F"),
  //    we won't guess at deeper partial matches.
  if (/\s/.test(rawName)) {
    return {
      samOwnerId: null,
      samOwnerName: null,
      warning: `SAM name "${rawName}" did not match any user. Imported as unassigned.`,
    };
  }
  const firstNameMatches = findByFirstName(directory, lower);
  if (firstNameMatches.length === 1) {
    return {
      samOwnerId: firstNameMatches[0]!.id,
      samOwnerName: firstNameMatches[0]!.name,
      warning: null,
    };
  }
  if (firstNameMatches.length > 1) {
    const names = firstNameMatches.map((m) => m.name).join(', ');
    return {
      samOwnerId: null,
      samOwnerName: null,
      warning: `SAM "${rawName}" is ambiguous — could be ${names}. Use the SAM's email or full name. Imported as unassigned.`,
    };
  }
  return {
    samOwnerId: null,
    samOwnerName: null,
    warning: `SAM name "${rawName}" did not match any user. Imported as unassigned.`,
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
  circuitId?: string | null;
  customerCode?: string | null;
  address?: string | null;
  samOwnerId?: string | null;
  gstNumber?: string | null;
  contactPersonName?: string | null;
  industryType?: string | null;
  circle?: string | null;
  accountManager?: string | null;
  userName?: string | null;
  ipDetails?: string | null;
  metadata?: object;
};

function validate(
  row: ParsedRow,
  samDirectory: SamDirectory,
):
  | { error: string; kind: ImportErrorKind }
  | { data: ValidatedData; samOwnerName: string | null; warning: string | null } {
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

  const sam = resolveSam(c, samDirectory);

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
      circuitId: c.circuitId?.trim() || null,
      customerCode: c.customerCode?.trim() || null,
      address: c.address?.trim() || null,
      samOwnerId: sam.samOwnerId,
      gstNumber: c.gstNumber?.trim() || null,
      contactPersonName: c.contactPersonName?.trim() || null,
      industryType: c.industryType?.trim() || null,
      circle: c.circle?.trim() || null,
      accountManager: c.accountManager?.trim() || null,
      userName: c.userName?.trim() || null,
      ipDetails: c.ipDetails?.trim() || null,
      metadata: Object.keys(row.metadata).length > 0 ? row.metadata : undefined,
    },
    samOwnerName: sam.samOwnerName,
    warning: sam.warning,
  };
}
