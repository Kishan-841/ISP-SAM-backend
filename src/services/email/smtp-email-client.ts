import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailClient, EmailMessage, SendResult } from './email-client.js';

/**
 * Generic SMTP transport via nodemailer. Works with any SMTP provider:
 * Netcore SMTP, Gmail, Office 365, AWS SES SMTP, self-hosted Postfix.
 *
 * Why this exists alongside the REST clients (Netcore / Resend): some
 * deployments either can't reach the provider's REST API (firewall, lack
 * of allowlisting) or use a provider that only offers SMTP. SMTP also
 * doesn't need per-IP allowlist coordination — the provider's auth
 * check (username/password) is the gate, not the source IP.
 *
 * Configured via EMAIL_TRANSPORT=smtp + the SMTP_* env vars. See
 * email-client.ts:buildSmtp().
 *
 * Contract: send() never throws — failure returns { ok: false, error }.
 */
export class SmtpEmailClient implements EmailClient {
  private readonly transporter: Transporter;
  private readonly fromEmail: string;
  private readonly fromName: string;
  private readonly replyTo: string | undefined;

  constructor(opts: {
    host: string;
    port: number;
    /** true for implicit TLS (port 465); false for plain or STARTTLS */
    secure: boolean;
    /** Force STARTTLS upgrade when secure=false. Recommended for port 587. */
    requireTLS?: boolean;
    user: string;
    pass: string;
    fromEmail: string;
    fromName?: string;
    replyTo?: string;
  }) {
    if (!opts.host) throw new Error('SmtpEmailClient: host is required');
    if (!opts.user) throw new Error('SmtpEmailClient: user is required');
    if (!opts.pass) throw new Error('SmtpEmailClient: pass is required');
    if (!opts.fromEmail) throw new Error('SmtpEmailClient: fromEmail is required');

    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      requireTLS: opts.requireTLS,
      auth: { user: opts.user, pass: opts.pass },
      // Keep the connection pool small — we send a handful of transactional
      // emails per minute, not bulk.
      pool: true,
      maxConnections: 3,
      maxMessages: 50,
    });

    this.fromEmail = opts.fromEmail;
    this.fromName = opts.fromName ?? 'Gazon SAM';
    this.replyTo = opts.replyTo;
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const fromEmail = message.from?.email ?? this.fromEmail;
    const fromName = message.from?.name ?? this.fromName;
    const replyTo = message.replyTo ?? this.replyTo;

    try {
      const info = await this.transporter.sendMail({
        from: { address: fromEmail, name: fromName },
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        replyTo,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      // info.messageId is RFC-format with angle brackets; strip them so audit
      // log entries are consistent with the other transports.
      const messageId = (info.messageId ?? '').replace(/^<|>$/g, '') || `smtp-${Date.now()}`;
      return { ok: true, messageId };
    } catch (err) {
      // nodemailer surfaces SMTP-numeric codes on its errors (responseCode,
      // response). Surface what we can in the error string so the audit log
      // diagnoses itself — same pattern as netcore-email-client's `body.error`.
      const e = err as { code?: string; responseCode?: number; response?: string; message?: string };
      const parts: string[] = [];
      if (e.responseCode) parts.push(`SMTP ${e.responseCode}`);
      else if (e.code) parts.push(e.code);
      if (e.response) parts.push(e.response);
      else if (e.message) parts.push(e.message);
      const error = parts.length > 0 ? parts.join(': ') : 'SMTP send failed';
      return { ok: false, error };
    }
  }
}
