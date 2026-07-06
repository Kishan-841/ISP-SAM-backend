import * as XLSX from 'xlsx';
import { mapHeader, type CanonicalRow } from './header-map.js';

export type ParsedRow = {
  rowNumber: number;            // 1-indexed for human-friendly errors (header is row 1)
  canonical: CanonicalRow;
  metadata: Record<string, unknown>;  // unknown columns under their original header
};

export type ParseResult = {
  rows: ParsedRow[];
  errors: { rowNumber: number; reason: string }[];
};

export function parseWorkbook(buffer: Buffer): ParseResult {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { rows: [], errors: [{ rowNumber: 0, reason: 'Workbook has no sheets' }] };
  }
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return { rows: [], errors: [{ rowNumber: 0, reason: 'Sheet is empty' }] };
  }
  // Convert to array-of-arrays so we can read headers explicitly.
  const aoa: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
  if (aoa.length === 0) {
    return { rows: [], errors: [{ rowNumber: 0, reason: 'Sheet is empty' }] };
  }
  const headers = (aoa[0] as string[]).map((h) => String(h ?? '').trim());
  const rows: ParsedRow[] = [];
  const errors: ParseResult['errors'] = [];

  for (let i = 1; i < aoa.length; i++) {
    const raw = aoa[i] as unknown[];
    if (raw.every((v) => v === null || v === '' || v === undefined)) continue; // skip blank rows
    const canonical: CanonicalRow = {};
    const metadata: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      if (!header) continue;
      const value = raw[c];
      if (value === null || value === undefined || value === '') continue;
      // Operators often type "NA", "N/A", "-", "—", "TBD" into empty cells.
      // Treat these as absent — produces a clean "Missing X" rejection later
      // instead of a confusing "Invalid date for NA".
      if (isEmptySentinel(value)) continue;
      const key = mapHeader(header);
      if (!key) {
        metadata[header] = value;
        continue;
      }
      if (key === 'currentArc') {
        const n = parseNumber(value);
        if (n === null) {
          errors.push({ rowNumber: i + 1, reason: `Invalid number for ${header}: ${String(value)}` });
          continue;
        }
        canonical.currentArc = n;
      } else if (key === '__monthlyMrrLegacy') {
        // Legacy monthly MRR header — convert to annual at the boundary.
        // Don't overwrite an explicit ARC column on the same row.
        const n = parseNumber(value);
        if (n === null) {
          errors.push({ rowNumber: i + 1, reason: `Invalid number for ${header}: ${String(value)}` });
          continue;
        }
        if (canonical.currentArc === undefined) canonical.currentArc = n * 12;
      } else if (key === 'bandwidthMbps') {
        const n = parseInt(String(value).replace(/[^0-9]/g, ''), 10);
        if (Number.isFinite(n)) canonical[key] = n;
        // else silently skip — bandwidth is optional
      } else if (key === 'onboardingDate') {
        const d = parseDate(value);
        if (d === null) {
          errors.push({ rowNumber: i + 1, reason: `Invalid date for ${header}: ${String(value)}` });
          continue;
        }
        canonical[key] = d;
      } else if (key === 'kittyType') {
        // Explicit OLD/NEW override. Unrecognised labels are silently
        // dropped so validate() falls back to the onboarding-date rule.
        const kt = normalizeKittyLabel(value);
        if (kt) canonical.kittyType = kt;
      } else {
        (canonical as Record<string, unknown>)[key] = String(value).trim();
      }
    }
    rows.push({ rowNumber: i + 1, canonical, metadata });
  }
  return { rows, errors };
}

// Common "no value" sentinels operators type into spreadsheets when a cell
// is empty. Treating these as null produces a clean "Missing X" rejection
// instead of "Invalid X" — same outcome, friendlier error message.
const EMPTY_SENTINELS = new Set(['', '-', '–', '—', 'na', 'n/a', 'null', 'none', 'tbd', 'tbc']);

function isEmptySentinel(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  const s = String(v).trim().toLowerCase();
  return EMPTY_SENTINELS.has(s);
}

/**
 * Map a free-text OLD/NEW label to the canonical kitty. OLD / EXISTING /
 * BASE (and "existing base") → BASE; NEW / "new base" → NEW. Anything else
 * → null so the caller falls back to the onboarding-date rule.
 */
function normalizeKittyLabel(v: unknown): 'BASE' | 'NEW' | null {
  const s = String(v).trim().toLowerCase().replace(/[^a-z]/g, '');
  if (s === 'old' || s === 'existing' || s === 'base' || s === 'existingbase') return 'BASE';
  if (s === 'new' || s === 'newbase') return 'NEW';
  return null;
}

function parseNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (isEmptySentinel(v)) return null;
  const s = String(v).replace(/[,₹\s]/g, '').replace(/L$/i, ''); // strip ₹, commas, optional 'L' suffix
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const MONTH_ABBR: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (isEmptySentinel(v)) return null;
  const s = String(v).trim();
  if (!s) return null;

  // ISO: YYYY-MM-DD
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
  let m = s.match(iso);
  if (m) return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));

  // Indian numeric: DD/MM/YYYY  or  DD-MM-YYYY
  const numericDmy = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/;
  m = s.match(numericDmy);
  if (m) {
    const day = +m[1]!;
    const month = +m[2]!;
    let year = +m[3]!;
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return new Date(Date.UTC(year, month - 1, day));
  }

  // Indian abbreviated month: DD-Mon-YY, DD-Mon-YYYY, DD/Mon/YYYY, DD Mon YYYY
  //   e.g. "31-Aug-20", "1-Apr-2024", "15 Mar 2025"
  const dmyAbbr = /^(\d{1,2})[\s\/-]([A-Za-z]{3,4})[\s\/-](\d{2,4})$/;
  m = s.match(dmyAbbr);
  if (m) {
    const day = +m[1]!;
    const month = MONTH_ABBR[m[2]!.toLowerCase()];
    if (month === undefined) return null;
    let year = +m[3]!;
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return new Date(Date.UTC(year, month, day));
  }

  // Last-resort fallback. Native parsing risks a TZ shift, so we re-anchor
  // to UTC midnight using the parsed Y/M/D.
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}
