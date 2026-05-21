import { NetcoreEmailClient } from './netcore-email-client.js';
import { ResendEmailClient } from './resend-email-client.js';
import { SmtpEmailClient } from './smtp-email-client.js';

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
  // EMAIL_TRANSPORT explicitly picks the transport, ignoring the
  // auto-detect that would otherwise prefer Resend when its key is set.
  //   EMAIL_TRANSPORT=netcore  → Netcore REST API
  //   EMAIL_TRANSPORT=resend   → Resend
  //   EMAIL_TRANSPORT=smtp     → generic SMTP via nodemailer (Netcore-SMTP,
  //                              Gmail, Office 365, AWS SES, anything)
  //   EMAIL_TRANSPORT=logging  → no-op stub (good for local dev)
  //   unset / anything else    → auto-detect (Resend → Netcore → logging)
  const explicit = (process.env.EMAIL_TRANSPORT ?? '').trim().toLowerCase();
  if (explicit === 'logging') return new LoggingEmailClient();
  if (explicit === 'netcore') return buildNetcore() ?? new LoggingEmailClient();
  if (explicit === 'resend') return buildResend() ?? new LoggingEmailClient();
  if (explicit === 'smtp') return buildSmtp() ?? new LoggingEmailClient();
  // Auto-detect — Resend first, then Netcore, finally logging stub.
  return buildResend() ?? buildNetcore() ?? new LoggingEmailClient();
}

function buildNetcore(): NetcoreEmailClient | null {
  const apiKey = process.env.NETCORE_API_KEY;
  const fromEmail = process.env.NETCORE_FROM_EMAIL;
  if (!apiKey || !fromEmail) return null;
  return new NetcoreEmailClient({
    apiKey,
    fromEmail,
    fromName: process.env.NETCORE_FROM_NAME ?? 'Gazon SAM',
    replyTo: process.env.NETCORE_REPLY_TO,
  });
}

function buildResend(): ResendEmailClient | null {
  // Accept either RESEND_API_KEY (canonical) or the lowercase variant.
  const apiKey = process.env.RESEND_API_KEY ?? process.env.resend_api_key;
  if (!apiKey) return null;
  return new ResendEmailClient({
    apiKey,
    fromEmail: process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev',
    fromName: process.env.RESEND_FROM_NAME ?? 'Gazon SAM',
    replyTo: process.env.RESEND_REPLY_TO,
  });
}

function buildSmtp(): SmtpEmailClient | null {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  const fromEmail = process.env.SMTP_FROM_EMAIL ?? process.env.NETCORE_FROM_EMAIL;
  if (!host || !user || !pass || !fromEmail) return null;
  const port = Number(process.env.SMTP_PORT ?? 587);
  // Port 465 = implicit TLS; everything else (25, 587, 2525) = no implicit TLS.
  // For 587 we request STARTTLS to upgrade after EHLO; for 25 we allow plain
  // (most providers reject auth-over-plain anyway, so this still ends up
  // requiring TLS in practice).
  const secure = port === 465;
  const requireTLS = port === 587;
  return new SmtpEmailClient({
    host,
    port,
    secure,
    requireTLS,
    user,
    pass,
    fromEmail,
    fromName: process.env.SMTP_FROM_NAME ?? process.env.NETCORE_FROM_NAME ?? 'Gazon SAM',
    replyTo: process.env.SMTP_REPLY_TO ?? process.env.NETCORE_REPLY_TO,
  });
}

/** Used by tests to swap in a fake. */
export function setEmailClientForTests(client: EmailClient | null): void {
  testOverride = client;
}

/** Used by tests / integration to drop the cached singleton. */
export function resetEmailClientCache(): void {
  cachedClient = null;
}
