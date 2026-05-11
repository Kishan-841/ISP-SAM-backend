import type { EmailClient, EmailMessage, SendResult } from './email-client.js';

/**
 * Netcore Email API v5 transport.
 *
 * Docs: https://docs.netcorecloud.com/docs/email-api
 * Endpoint:  POST https://emailapi.netcorecloud.net/v5/mail/send
 * Auth:      `api_key: <key>` request header
 *
 * Notes for future-you:
 *  - Sender domain (e.g. gazonindia.com) MUST be verified in the Netcore
 *    dashboard via SPF + DKIM DNS records — otherwise Netcore accepts the
 *    request but the message is dropped or junked.
 *  - From here, any `@<verified-domain>` address can be set as the sender.
 *  - We currently send from a single configured address. To send "as the
 *    SAM" (e.g. avinash@gazonindia.com) later, plumb a `from` field through
 *    `EmailMessage` and override `this.fromEmail` per-call.
 */

const DEFAULT_ENDPOINT = 'https://emailapi.netcorecloud.net/v5/mail/send';

type NetcoreSendResponse = {
  message?: string;
  data?: { message_id?: string };
  errors?: Array<{ message?: string; code?: number }>;
};

export class NetcoreEmailClient implements EmailClient {
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
    if (!opts.apiKey) throw new Error('NetcoreEmailClient: apiKey is required');
    if (!opts.fromEmail) throw new Error('NetcoreEmailClient: fromEmail is required');
    this.apiKey = opts.apiKey;
    this.fromEmail = opts.fromEmail;
    this.fromName = opts.fromName ?? 'Gazon SAM';
    this.replyTo = opts.replyTo;
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const personalization: Record<string, unknown> = {
      to: [{ email: message.to }],
    };
    if (message.cc && message.cc.length > 0) {
      personalization.cc = message.cc.map((email) => ({ email }));
    }
    if (message.bcc && message.bcc.length > 0) {
      personalization.bcc = message.bcc.map((email) => ({ email }));
    }

    const fromEmail = message.from?.email ?? this.fromEmail;
    const fromName = message.from?.name ?? this.fromName;
    const replyTo = message.replyTo ?? this.replyTo;

    const payload: Record<string, unknown> = {
      from: { email: fromEmail, name: fromName },
      subject: message.subject,
      content: [
        { type: 'html', value: message.html },
        { type: 'text', value: message.text },
      ],
      personalizations: [personalization],
    };
    if (replyTo) {
      payload.reply_to = { email: replyTo };
    }

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          api_key: this.apiKey,
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

    const body = (await res.json().catch(() => ({}))) as NetcoreSendResponse;

    if (!res.ok) {
      const detail =
        body.errors?.map((e) => e.message).filter(Boolean).join('; ') ||
        body.message ||
        `HTTP ${res.status}`;
      return { ok: false, error: `Netcore rejected: ${detail}` };
    }

    // Successful v5 response shape:
    //   { message: "Email accepted for delivery", data: { message_id: "<id>" } }
    const messageId = body.data?.message_id ?? `netcore-${Date.now()}`;
    return { ok: true, messageId };
  }
}
