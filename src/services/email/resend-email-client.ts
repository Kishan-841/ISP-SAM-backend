import type { EmailClient, EmailMessage, SendResult } from './email-client.js';

/**
 * Resend transport (https://resend.com).
 *
 *   POST https://api.resend.com/emails
 *   Authorization: Bearer <api_key>
 *
 * Resend will accept the request from `onboarding@resend.dev` while you're
 * still in the sandbox; once `gazonindia.com` (or whichever sending domain
 * you pick) is added + DKIM/SPF verified in the Resend dashboard, set
 * RESEND_FROM_EMAIL to a real address on that domain and Resend will deliver
 * to any recipient. Until the domain is verified, Resend will only deliver
 * to the account owner's email — that's a quirk of Resend's free tier, not
 * a bug.
 *
 * Contract is identical to NetcoreEmailClient: never throws, returns
 * `{ ok: true, messageId }` on success, `{ ok: false, error }` otherwise.
 */

const DEFAULT_ENDPOINT = 'https://api.resend.com/emails';

type ResendSendResponse = {
  id?: string;
  // Error shape: { name, message, statusCode }
  name?: string;
  message?: string;
  statusCode?: number;
};

export class ResendEmailClient implements EmailClient {
  private readonly apiKey: string;
  private readonly fromEmail: string;
  private readonly fromName: string;
  private readonly endpoint: string;
  private readonly replyTo: string | undefined;

  constructor(opts: {
    apiKey: string;
    fromEmail: string;
    fromName?: string;
    replyTo?: string;
    endpoint?: string;
  }) {
    if (!opts.apiKey) throw new Error('ResendEmailClient: apiKey is required');
    if (!opts.fromEmail) throw new Error('ResendEmailClient: fromEmail is required');
    this.apiKey = opts.apiKey;
    this.fromEmail = opts.fromEmail;
    this.fromName = opts.fromName ?? 'Gazon SAM';
    this.replyTo = opts.replyTo;
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const fromEmail = message.from?.email ?? this.fromEmail;
    const fromName = message.from?.name ?? this.fromName;
    const replyTo = message.replyTo ?? this.replyTo;

    const payload: Record<string, unknown> = {
      from: `${fromName} <${fromEmail}>`,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    };
    if (message.cc && message.cc.length > 0) payload.cc = message.cc;
    if (message.bcc && message.bcc.length > 0) payload.bcc = message.bcc;
    if (replyTo) payload.reply_to = replyTo;

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? `Network error: ${err.message}` : 'Network error',
      };
    }

    const body = (await res.json().catch(() => ({}))) as ResendSendResponse;

    if (!res.ok) {
      const detail = body.message || body.name || `HTTP ${res.status}`;
      return { ok: false, error: `Resend rejected: ${detail}` };
    }

    const messageId = body.id ?? `resend-${Date.now()}`;
    return { ok: true, messageId };
  }
}
