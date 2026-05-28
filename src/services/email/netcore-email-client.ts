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
  message?: unknown;
  // Success: data = { message_id }. Failure (v5 validation): data = [{ code, message, more_info }, ...]
  data?: unknown;
  errors?: unknown;
  error?: unknown;
};

function extractNetcoreError(body: NetcoreSendResponse, status: number): string {
  const stringify = (item: unknown): string => {
    if (item == null) return '';
    if (typeof item === 'string') return item;
    if (typeof item === 'number' || typeof item === 'boolean') return String(item);
    if (typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const msg = o.message ?? o.error ?? o.reason ?? o.detail ?? o.more_info ?? o.description;
      if (typeof msg === 'string' && msg.trim()) {
        const code = o.code ?? o.statusCode;
        return code != null ? `${msg} (code=${String(code)})` : msg;
      }
      try {
        return JSON.stringify(item);
      } catch {
        return '[unserializable]';
      }
    }
    return String(item);
  };

  const fromList = (list: unknown): string | null => {
    if (!Array.isArray(list) || list.length === 0) return null;
    const parts = list.map(stringify).filter((s) => s && s.length > 0);
    return parts.length > 0 ? parts.join('; ') : null;
  };

  // 1. Top-level string fields
  if (typeof body.error === 'string' && body.error.trim()) return body.error;
  if (typeof body.message === 'string' && body.message.trim()) return body.message;

  // 2. Array fields (any of error / errors / data when not the success shape)
  const dataAsList = Array.isArray(body.data) ? body.data : null;
  const fromAny =
    fromList(body.errors) ??
    fromList(body.error) ??
    fromList(dataAsList);
  if (fromAny) return fromAny;

  // 3. Single-object fields (e.g. message: { ... } or data: { error: "..." } in non-success path)
  if (body.message && typeof body.message === 'object') {
    const s = stringify(body.message);
    if (s) return s;
  }
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    const o = body.data as Record<string, unknown>;
    // Treat as error only if no message_id (otherwise it's success)
    if (!('message_id' in o)) {
      const s = stringify(body.data);
      if (s && s !== '{}') return s;
    }
  }

  // 4. Last resort — full body dump
  try {
    const dump = JSON.stringify(body);
    if (dump && dump !== '{}') return dump;
  } catch {
    // ignore
  }
  return `HTTP ${status}`;
}

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

    // Read response as text first so we can log it raw even when JSON parse
    // fails or when the body has a non-JSON content-type.
    const rawText = await res.text().catch(() => '');
    let body: NetcoreSendResponse = {};
    try {
      body = rawText ? (JSON.parse(rawText) as NetcoreSendResponse) : {};
    } catch {
      // Keep body empty; rawText still gets logged below for diagnosis.
    }

    // Netcore v5 sometimes returns HTTP 200 with an error payload (e.g. body
    // = { data: [{ code: 422, message: "..." }] } and no message_id). Treat
    // that as a failure too.
    const hasSuccessShape =
      body.data && typeof body.data === 'object' && !Array.isArray(body.data) &&
      typeof (body.data as Record<string, unknown>).message_id === 'string';

    if (!res.ok || !hasSuccessShape) {
      const detail = extractNetcoreError(body, res.status) || rawText.slice(0, 500) || `HTTP ${res.status}`;
      // eslint-disable-next-line no-console
      console.warn('[netcore] send failed', JSON.stringify({
        status: res.status,
        rawText: rawText.slice(0, 1000),
        parsedBody: body,
        to: message.to,
        subject: message.subject,
      }, null, 2));
      return { ok: false, error: `Netcore rejected: ${detail}` };
    }

    const messageId = (body.data as { message_id: string }).message_id;
    return { ok: true, messageId };
  }
}
