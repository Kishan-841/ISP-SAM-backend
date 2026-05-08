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
  to: string;
  cc?: string[];
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
  if (!cachedClient) cachedClient = new LoggingEmailClient();
  return cachedClient;
}

/** Used by tests to swap in a fake. */
export function setEmailClientForTests(client: EmailClient | null): void {
  testOverride = client;
}

/** Used by tests / integration to drop the cached singleton. */
export function resetEmailClientCache(): void {
  cachedClient = null;
}
