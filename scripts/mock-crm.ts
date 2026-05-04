#!/usr/bin/env node
/**
 * Mock CRM webhook caller — sends a customer.activated event to the local
 * SAM backend, signed exactly the way crm.gazonindia.com will sign it in
 * production. Use this for manual smoke tests AND as the reference spec
 * for whoever builds the outbound caller on the CRM side.
 *
 *   pnpm exec tsx scripts/mock-crm.ts \
 *     --company "HealthPlus Hospitals" \
 *     --contact "Priya Nair" \
 *     --mrr 50000
 *
 * Flags (all optional):
 *   --url        SAM webhook URL          (default: http://localhost:5500/integrations/crm/customer-activated)
 *   --secret     Shared secret             (default: $CRM_WEBHOOK_SECRET)
 *   --company    Company name              (default: a sample)
 *   --contact    Contact person name
 *   --email      Contact email
 *   --phone      Contact phone
 *   --circuit    Circuit ID
 *   --bandwidth  Bandwidth in Mbps
 *   --plan       Current plan name
 *   --mrr        Current MRR (rupees)      (required by SAM)
 *   --externalId CRM lead UUID             (default: random — emulates a brand new customer)
 *   --eventId    Webhook event UUID        (default: random — change to reuse an event for replay testing)
 *   --tamper     Set this to flip the body after signing (negative test)
 *   --skewSeconds Subtract this many seconds from the timestamp (replay-window negative test)
 */

import crypto from 'node:crypto';
import { config as loadEnv } from 'dotenv';

loadEnv();

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv);

const url =
  (args.url as string) ?? 'http://localhost:5500/integrations/crm/customer-activated';
const secret = (args.secret as string) ?? process.env.CRM_WEBHOOK_SECRET;

if (!secret) {
  console.error('Missing shared secret. Pass --secret or set CRM_WEBHOOK_SECRET in .env.');
  process.exit(2);
}

const payload = {
  eventId: (args.eventId as string) ?? crypto.randomUUID(),
  eventType: 'customer.activated' as const,
  occurredAt: new Date().toISOString(),
  customer: {
    externalId:
      (args.externalId as string) ?? `lead-${crypto.randomUUID().slice(0, 8)}`,
    companyName: (args.company as string) ?? 'HealthPlus Hospitals',
    contactName: (args.contact as string) ?? 'Priya Nair',
    email: (args.email as string) ?? 'ops@healthplus.in',
    phone: (args.phone as string) ?? '+919999999999',
    circuitId: (args.circuit as string) ?? null,
    bandwidthMbps: args.bandwidth ? Number(args.bandwidth) : 100,
    currentPlan: (args.plan as string) ?? 'Enterprise 100Mbps',
    currentMrr: args.mrr ? Number(args.mrr) : 50000,
    onboardingDate: new Date().toISOString().slice(0, 10),
  },
};

const skew = args.skewSeconds ? Number(args.skewSeconds) : 0;
const timestamp = Math.floor(Date.now() / 1000) - skew;

let body = JSON.stringify(payload);
const signature = crypto
  .createHmac('sha256', secret)
  .update(`${timestamp}.`)
  .update(body)
  .digest('hex');

if (args.tamper) {
  // Flip the MRR after signing — server should reject with 401.
  const tampered = JSON.parse(body);
  tampered.customer.currentMrr = 999_999_999;
  body = JSON.stringify(tampered);
}

console.log(`POST ${url}`);
console.log(`X-CRM-Signature: ${signature}`);
console.log(`X-CRM-Timestamp: ${timestamp}`);
console.log('Body:', body);

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-CRM-Signature': signature,
    'X-CRM-Timestamp': String(timestamp),
  },
  body,
});

const text = await res.text();
console.log(`\n← HTTP ${res.status}`);
console.log(text);

if (!res.ok && res.status !== 200) process.exit(1);
