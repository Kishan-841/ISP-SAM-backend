import * as XLSX from 'xlsx';
import { mapHeader, type CanonicalRow } from './header-map.js';

export type ParsedRow = {
  /** 1-indexed row number for human-friendly error messages (header is row 1). */
  rowNumber: number;
  canonical: CanonicalRow;
};

export type ParseResult = {
  rows: ParsedRow[];
  errors: { rowNumber: number; reason: string }[];
};

/**
 * Bulk commercial-change workbook parser. Mirrors the accounts `parseWorkbook`
 * shape but with a smaller column set. Header matching is loose: case, spaces,
 * underscores, slashes and hyphens are stripped before lookup.
 *
 *   Required columns (canonical names — see header-map.ts for aliases):
 *     circuitId        — looked up against accounts.circuit_id
 *     changeType       — UPGRADE | DOWNGRADE | RATE_REVISION | DISCONNECTION
 *     effectiveDate    — date the change took effect (YYYY-MM-DD)
 *
 *   Conditionally required:
 *     newArc                  — required for UPGRADE / DOWNGRADE / RATE_REVISION
 *     newBandwidthMbps        — required for UPGRADE / RATE_REVISION (the
 *                                bandwidth-on-same-ARC case)
 *     disconnectionReason     — required for DISCONNECTION; must match a
 *                                canonical disconnection-reason code
 *
 *   Optional:
 *     mailReceivedDate, reason
 */
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
  const aoa: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: false,
  });
  if (aoa.length === 0) {
    return { rows: [], errors: [{ rowNumber: 0, reason: 'Sheet is empty' }] };
  }
  const headers = (aoa[0] as string[]).map((h) => String(h ?? '').trim());
  const rows: ParsedRow[] = [];
  const errors: ParseResult['errors'] = [];

  for (let i = 1; i < aoa.length; i++) {
    const raw = aoa[i] as unknown[];
    if (raw.every((v) => v === null || v === '' || v === undefined)) continue;
    const canonical: CanonicalRow = {};
    let rowHasError = false;
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      if (!header) continue;
      const value = raw[c];
      if (value === null || value === undefined || value === '') continue;
      if (isEmptySentinel(value)) continue;
      const key = mapHeader(header);
      if (!key) continue; // unknown column — silently ignored

      try {
        switch (key) {
          case 'circuitId':
          case 'changeType':
          case 'disconnectionReason':
          case 'reason':
            canonical[key] = String(value).trim() as never;
            break;
          case 'newArc':
          case 'newBandwidthMbps': {
            const n = parseNumber(value);
            if (n === null) {
              errors.push({
                rowNumber: i + 1,
                reason: `Row ${i + 1}: invalid number for "${header}": ${value}`,
              });
              rowHasError = true;
            } else {
              canonical[key] = n as never;
            }
            break;
          }
          case 'effectiveDate':
          case 'mailReceivedDate': {
            const d = parseDate(value);
            if (d === null) {
              errors.push({
                rowNumber: i + 1,
                reason: `Row ${i + 1}: invalid date for "${header}": ${value}`,
              });
              rowHasError = true;
            } else {
              canonical[key] = d as never;
            }
            break;
          }
        }
      } catch (err) {
        errors.push({
          rowNumber: i + 1,
          reason: `Row ${i + 1}: failed to parse "${header}" — ${err instanceof Error ? err.message : String(err)}`,
        });
        rowHasError = true;
      }
    }
    if (!rowHasError) rows.push({ rowNumber: i + 1, canonical });
  }

  return { rows, errors };
}

function isEmptySentinel(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  return s === 'na' || s === 'n/a' || s === '-' || s === '—' || s === 'tbd';
}

function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  // Tolerate ₹ symbols, commas, trailing /year etc.
  const cleaned = v.replace(/[₹$, ]/g, '').replace(/\/.*$/, '').trim();
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    // Excel serial date — XLSX usually converts to Date with cellDates: true,
    // but stay defensive in case a numeric leaks through.
    const ms = (v - 25569) * 86400 * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
