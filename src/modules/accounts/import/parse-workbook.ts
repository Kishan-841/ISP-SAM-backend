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
      } else {
        (canonical as Record<string, unknown>)[key] = String(value).trim();
      }
    }
    rows.push({ rowNumber: i + 1, canonical, metadata });
  }
  return { rows, errors };
}

function parseNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).replace(/[,₹\s]/g, '').replace(/L$/i, ''); // strip ₹, commas, optional 'L' suffix
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  const s = String(v).trim();
  // Accept ISO (YYYY-MM-DD) and DD/MM/YYYY (Indian format)
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const indian = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  if (iso.test(s)) return new Date(s + 'T00:00:00Z');
  const m = s.match(indian);
  if (m) return new Date(Date.UTC(+m[3]!, +m[2]! - 1, +m[1]!));
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}
