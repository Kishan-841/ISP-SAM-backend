/**
 * One-shot script to verify the Netcore email transport end-to-end.
 *
 * Usage:
 *   cd backend
 *   pnpm tsx scripts/test-netcore-email.ts you@example.com
 *
 * What it does:
 *   1. Loads .env
 *   2. Constructs an EmailClient via the same factory the app uses
 *   3. Logs which implementation it picked (Netcore vs. logging stub)
 *   4. Sends one HTML+text test email to the recipient passed as argv[2]
 *   5. Prints the messageId on success, or the rejection reason on failure
 *
 * This bypasses ACCOUNTS_NOTIFICATIONS_ENABLED so you can test without
 * flipping the master switch and risking real notifications firing.
 */

import 'dotenv/config';
import { getEmailClient } from '../src/services/email/email-client.js';

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: pnpm tsx scripts/test-netcore-email.ts <recipient@example.com>');
    process.exit(1);
  }

  const client = getEmailClient();
  console.log(`Using transport: ${client.constructor.name}`);
  if (client.constructor.name === 'LoggingEmailClient') {
    console.warn(
      'WARNING: NETCORE_API_KEY or NETCORE_FROM_EMAIL is not set — falling back to logging stub.',
    );
  }

  const subject = `SAM platform — Netcore transport test (${new Date().toISOString()})`;
  const html = `
    <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #ea580c; margin: 0 0 12px;">It works.</h2>
      <p style="color: #374151; line-height: 1.5;">
        If you're reading this in your inbox, the Netcore transport is wired up correctly
        and the SAM platform can deliver real email.
      </p>
      <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">
        Sent from <code>${process.env.NETCORE_FROM_EMAIL ?? '(unset)'}</code>
      </p>
    </div>
  `;
  const text =
    'It works. If you got this, the Netcore transport is wired up and the SAM platform can deliver real email.';

  const result = await client.send({
    to,
    subject,
    html,
    text,
    meta: { script: 'test-netcore-email' },
  });

  if (result.ok) {
    console.log(`✅ Sent. messageId=${result.messageId}`);
    process.exit(0);
  } else {
    console.error(`❌ Failed: ${result.error}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(3);
});
