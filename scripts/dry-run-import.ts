import { readFileSync } from 'node:fs';
import { parseWorkbook } from '../src/modules/accounts/import/parse-workbook.js';
import { mapHeader, normalizeHeader } from '../src/modules/accounts/import/header-map.js';
import { deriveKittyType } from '../src/lib/kitty.js';

const buf = readFileSync('/Users/gazon/Desktop/isp_leads_customers_updated.xlsx');

// We mirror the importer's validate() inline so we don't have to spin up Prisma.
import * as XLSX from 'xlsx';
const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
const sheetNames = wb.SheetNames;

console.log('═══ SHEETS ═══');
console.log(sheetNames);
console.log();

const sheet = wb.Sheets[sheetNames[0]!];
const aoa: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
const headers = (aoa[0] as string[]).map((h) => String(h ?? '').trim());

console.log('═══ HEADERS (' + headers.length + ') ═══');
for (const h of headers) {
  const mapped = mapHeader(h);
  const norm = normalizeHeader(h);
  console.log(
    `  "${h}"`.padEnd(40),
    `→ normalized: "${norm}"`.padEnd(40),
    `→ ${mapped ?? '(stored in metadata, ignored for required-field check)'}`,
  );
}
console.log();

// Now run the actual parseWorkbook
const parsed = parseWorkbook(buf);
console.log('═══ PARSE RESULT ═══');
console.log(`Rows parsed: ${parsed.rows.length}`);
console.log(`Parse errors: ${parsed.errors.length}`);
if (parsed.errors.length > 0) {
  console.log('Errors:');
  for (const e of parsed.errors) console.log(`  row ${e.rowNumber}: ${e.reason}`);
}
console.log();

// Mimic validate()
type CanonicalRow = NonNullable<typeof parsed.rows[number]>['canonical'];
function validate(c: CanonicalRow): string | null {
  if (!c.clientName) return 'Missing customer/client name';
  if (!c.onboardingDate) return 'Missing onboarding date';
  if (typeof c.currentArc !== 'number') return 'Missing ARC';
  return null;
}

console.log('═══ ROW-BY-ROW VALIDATION ═══');
let ok = 0, bad = 0;
const baseCount = { BASE: 0, NEW: 0 };
for (const row of parsed.rows) {
  const err = validate(row.canonical);
  if (err) {
    bad++;
    console.log(
      `  row ${row.rowNumber}: SKIP — ${err}`,
      JSON.stringify({ name: row.canonical.clientName, date: row.canonical.onboardingDate, arc: row.canonical.currentArc }),
    );
  } else {
    ok++;
    const kitty = deriveKittyType(row.canonical.onboardingDate!);
    baseCount[kitty]++;
  }
}
console.log();
console.log(`Result: ${ok} importable, ${bad} would be skipped`);
console.log(`Kitty split (importable rows): BASE=${baseCount.BASE}, NEW=${baseCount.NEW}`);
console.log();

// Sanity-check the first 3 valid rows so user can eyeball the parsed values.
console.log('═══ FIRST 3 ROWS — PARSED VALUES ═══');
let shown = 0;
for (const row of parsed.rows) {
  if (validate(row.canonical) !== null) continue;
  console.log(`  row ${row.rowNumber}:`, JSON.stringify(row.canonical, null, 2));
  console.log(`    metadata (preserved but not surfaced anywhere):`, JSON.stringify(row.metadata));
  shown++;
  if (shown >= 3) break;
}
