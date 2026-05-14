import { NetcoreEmailClient } from './netcore-email-client.js';
import { ResendEmailClient } from './resend-email-client.js';

/**
 * Email transport abstraction.
 *
 * The platform doesn't ship with a real SMTP / Resend client yet — the only
 * implementation today is the no-op `LoggingEmailClient` which prints what
 * would have been sent. When the real transport (Resend, SES, etc.) is
 * wired up, drop in another implementation of `EmailClient` and swap it via
 * `setEmailClientForTests` (used by tests) or by changing the singleton in
 * `getEmailClient()`.
 *
 * Design contract:
 *  - `send` MUST NEVER throw. Caller treats failure as "delivery not
 *    confirmed"; it should not roll back the database operation that
 *    triggered the email.
 *  - On a successful delivery, return `{ ok: true, messageId }`.
 *  - On a failure, return `{ ok: false, error }`.
 */

export type EmailMessage = {
  /**
   * Per-message override for the From address. When unset, the client's
   * configured default (e.g. NETCORE_FROM_EMAIL) is used. Use this to send
   * AS a specific user — e.g. a SAM sending MOM to their customer.
   * NOTE: domain must be verified in the transport provider.
   */
  from?: { email: string; name?: string };
  to: string;
  cc?: string[];
  bcc?: string[];
  /** Per-message Reply-To override. Falls back to client default. */
  replyTo?: string;
  subject: string;
  /** Inline-styled HTML body. */
  html: string;
  /** Plain-text fallback. Most clients will render html, but this keeps
   *  spam scores down and supports text-only readers. */
  text: string;
  /** Optional context for logging — e.g. `{ commercialChangeId: '…' }`. */
  meta?: Record<string, unknown>;
};

export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

export interface EmailClient {
  send(message: EmailMessage): Promise<SendResult>;
}

/**
 * No-op implementation. Logs the would-be send and returns `ok: false` so
 * downstream code (which may stamp `accounts_notified_date` on success)
 * doesn't lie to the audit trail. Replace with a Resend wrapper once that
 * service is set up.
 */
export class LoggingEmailClient implements EmailClient {
  async send(message: EmailMessage): Promise<SendResult> {
    // Plain text only — html spams the dev console.
    // eslint-disable-next-line no-console
    console.warn(
      '[email-stub] would send:',
      JSON.stringify(
        {
          to: message.to,
          cc: message.cc,
          subject: message.subject,
          textPreview: message.text.slice(0, 200),
          meta: message.meta,
        },
        null,
        2,
      ),
    );
    return {
      ok: false,
      error: 'Email transport not configured. Plug in a real EmailClient to actually send.',
    };
  }
}

let cachedClient: EmailClient | null = null;
let testOverride: EmailClient | null = null;

export function getEmailClient(): EmailClient {
  if (testOverride) return testOverride;
  if (!cachedClient) cachedClient = buildClientFromEnv();
  return cachedClient;
}

function buildClientFromEnv(): EmailClient {
  // Prefer Resend when its API key is set — that's the active transport for
  // production today. Accept either RESEND_API_KEY (canonical) or the
  // lowercase resend_api_key (some shells / dotenv loaders preserve case).
  const resendKey = process.env.RESEND_API_KEY ?? process.env.resend_api_key;
  if (resendKey) {
    return new ResendEmailClient({
      apiKey: resendKey,
      fromEmail: process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev',
      fromName: process.env.RESEND_FROM_NAME ?? 'Gazon SAM',
      replyTo: process.env.RESEND_REPLY_TO,
    });
  }
  // Legacy Netcore transport — kept as a fallback in case anyone still has
  // those creds set on a deployed env.
  const netcoreKey = process.env.NETCORE_API_KEY;
  const netcoreFrom = process.env.NETCORE_FROM_EMAIL;
  if (netcoreKey && netcoreFrom) {
    return new NetcoreEmailClient({
      apiKey: netcoreKey,
      fromEmail: netcoreFrom,
      fromName: process.env.NETCORE_FROM_NAME ?? 'Gazon SAM',
      replyTo: process.env.NETCORE_REPLY_TO,
    });
  }
  return new LoggingEmailClient();
}

/** Used by tests to swap in a fake. */
export function setEmailClientForTests(client: EmailClient | null): void {
  testOverride = client;
}

/** Used by tests / integration to drop the cached singleton. */
export function resetEmailClientCache(): void {
  cachedClient = null;
}
