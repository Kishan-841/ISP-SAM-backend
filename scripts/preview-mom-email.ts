/**
 * Render the MOM-to-customer HTML to a file you can open in a browser.
 * Doesn't touch the DB or send anything.
 *
 * Usage:
 *   cd backend
 *   pnpm tsx scripts/preview-mom-email.ts
 *   open /tmp/mom-preview.html
 *
 * Edit the SAMPLE constant below to test different states (long MOM,
 * line breaks, missing customer code, etc.).
 */

import { writeFileSync } from 'node:fs';
import { buildMomToCustomerEmail } from '../src/services/email/templates/mom-to-customer.js';

const SAMPLE = {
  account: {
    clientName: 'Vikram Singh',
    companyName: 'Google',
    customerCode: 'GAZ-0009',
    circuitId: 'CKT-0010',
  },
  samName: 'Avinash Kumar',
  meetingScheduledAt: new Date('2026-05-09T10:00:00+05:30'),
  meetingHeldAt: new Date('2026-05-09T10:15:00+05:30'),
  meetingType: 'ONLINE' as const,
  momContent: `Discussed Q2 bandwidth plans. Customer is happy with current uptime (99.97%).

Key points:
- Considering an upgrade from 100 Mbps to 200 Mbps starting July.
- Requested a quote for redundant secondary circuit.
- Will revisit pricing once the Bangalore office relocation is finalised.

Next steps:
1. Send a formal upgrade quote by Friday.
2. Schedule a site survey for the secondary circuit.`,
};

const { subject, html, text } = buildMomToCustomerEmail(SAMPLE);

const outPath = '/tmp/mom-preview.html';
writeFileSync(outPath, html, 'utf8');
console.log(`Subject: ${subject}`);
console.log(`HTML preview written to: ${outPath}`);
console.log(`Open it:  open ${outPath}`);
console.log('');
console.log('--- Plain-text fallback ---');
console.log(text);
