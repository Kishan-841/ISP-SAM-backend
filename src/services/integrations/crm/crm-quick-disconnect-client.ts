import crypto from 'node:crypto';

/**
 * Pushes a `quickDisconnect.requested` event to CRM's webhook receiver.
 *
 * Contract:  docs/integrations/sam-quick-disconnect-contract.md on the CRM
 * repo (mirrored intent here; keep in sync with that file).
 *
 * Wire details (from §1):
 *   POST  ${CRM_QUICK_DISCONNECT_REQUESTED_URL}        — or
 *         ${CRM_API_BASE_URL}/webhooks/sam/quick-disconnect.requested
 *   Headers:  Content-Type: application/json
 *             X-SAM-Signature: hex(hmac-sha256(secret, `${ts}.${rawBody}`))
 *             X-SAM-Timestamp: unix seconds
 *   Secret:   CRM_WEBHOOK_SECRET (same shared secret used for inbound webhooks).
 *
 * Failure semantics — caller decides what to do with the result:
 *   - 2xx:        delivered (response carries `deduped: true` on idempotent replay)
 *   - 4xx:        permanent. Do not retry — the payload is wrong or stale.
 *   - 5xx / net:  transient. Caller may schedule a retry with the SAME eventId
 *                 so CRM's dedup catches it.
 *
 * This client itself never retries — the caller (commercial-changes.service)
 * persists the outcome and surfaces a manual retry button on the
 * /probable-churn quick-pending row.
 */

type PushInput = {
  commercialChangeId: string;
  /** CRM's lead UUID we received in the original customer.activated event. */
  externalCrmId: string;
  /** SAM user who raised the request. */
  raisedBy: { id: string; email: string };
  reason: string;
  requested: {
    arc?: number;
    planName?: string | null;
    bandwidth?: number | null;
    /** SAM's quickRequestedDays (1..15). The CRM contract doesn't accept this
     *  in the spec'd payload, but we send it under requested so the admin can
     *  see the SLA SAM is asking for. CRM may ignore unknown fields. */
    days?: number;
  };
};

export type PushResult =
  | { ok: true; status: number; eventId: string; deduped?: boolean }
  | { ok: false; status: number; eventId: string; error: string; retriable: boolean };

const DEFAULT_PATH = '/webhooks/sam/quick-disconnect.requested';

function resolveUrl(): string | null {
  const explicit = process.env.CRM_QUICK_DISCONNECT_REQUESTED_URL?.trim();
  if (explicit) return explicit;
  const base = process.env.CRM_API_BASE_URL?.trim();
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}${DEFAULT_PATH}`;
}

export async function pushQuickDisconnectRequest(input: PushInput): Promise<PushResult> {
  const url = resolveUrl();
  const secret = process.env.CRM_WEBHOOK_SECRET;
  const eventId = crypto.randomUUID();

  if (!url) {
    return {
      ok: false,
      status: 0,
      eventId,
      error:
        'CRM_QUICK_DISCONNECT_REQUESTED_URL (or CRM_API_BASE_URL) is not configured — cannot push to CRM.',
      retriable: false,
    };
  }
  if (!secret) {
    return {
      ok: false,
      status: 0,
      eventId,
      error: 'CRM_WEBHOOK_SECRET is not configured — cannot sign the request.',
      retriable: false,
    };
  }

  const payload = {
    eventId,
    eventType: 'quickDisconnect.requested' as const,
    occurredAt: new Date().toISOString(),
    commercialChangeId: input.commercialChangeId,
    customer: { externalId: input.externalCrmId },
    raisedBy: { id: input.raisedBy.id, email: input.raisedBy.email },
    reason: input.reason,
    requested: input.requested,
  };

  // CRITICAL: sign the EXACT bytes we send. JSON.stringify once, sign that
  // string, then send those same bytes. Re-stringifying would shuffle key
  // order and break the signature on the CRM side.
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${body}`)
    .digest('hex');

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SAM-Signature': sig,
        'X-SAM-Timestamp': String(ts),
      },
      body,
    });
  } catch (err) {
    // Network failure / DNS / TLS — treat as retriable.
    return {
      ok: false,
      status: 0,
      eventId,
      error: err instanceof Error ? `Network error: ${err.message}` : 'Network error',
      retriable: true,
    };
  }

  // 2xx = success. Body may carry { deduped: true } on idempotent replay.
  if (res.ok) {
    const text = await res.text().catch(() => '');
    let deduped = false;
    try {
      const parsed = text ? (JSON.parse(text) as { deduped?: boolean }) : null;
      deduped = !!parsed?.deduped;
    } catch {
      // Non-JSON 200 body — that's fine, treat as plain success.
    }
    return { ok: true, status: res.status, eventId, deduped };
  }

  // Non-2xx — capture the body for diagnostics. 4xx = permanent, 5xx = retriable.
  const errBody = await res.text().catch(() => '');
  const trimmed = errBody.length > 400 ? `${errBody.slice(0, 400)}…` : errBody;
  return {
    ok: false,
    status: res.status,
    eventId,
    error: `CRM responded ${res.status}: ${trimmed || res.statusText}`,
    retriable: res.status >= 500,
  };
}
