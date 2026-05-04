import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Replay window — incoming webhooks older than this many seconds are rejected
 * even if their signature is valid.
 */
const DEFAULT_REPLAY_WINDOW_SECONDS = 300;

export type VerifiedRequest = Request & {
  rawBody?: Buffer;
  crmTimestamp?: number;
  crmSignature?: string;
};

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify an inbound CRM webhook:
 *   1. The required headers are present.
 *   2. The timestamp is within the replay window.
 *   3. The HMAC-SHA256 signature over `${timestamp}.${rawBody}` matches what
 *      the CRM sent in `X-CRM-Signature`, computed with the shared secret.
 *
 * Body parsing in server.ts captures the raw bytes onto `req.rawBody` — we
 * sign over those exact bytes so JSON re-stringification can never drift.
 */
export function verifyCrmWebhook(secretEnvVar = 'CRM_WEBHOOK_SECRET') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const secret = process.env[secretEnvVar];
    if (!secret) {
      res.status(500).json({ error: `${secretEnvVar} is not configured` });
      return;
    }

    const r = req as VerifiedRequest;
    const signature = req.header('X-CRM-Signature');
    const timestampHeader = req.header('X-CRM-Timestamp');
    const rawBody = r.rawBody;

    if (!signature || !timestampHeader) {
      res.status(401).json({ error: 'Missing signature headers' });
      return;
    }
    if (!rawBody) {
      // Should never happen given the verify hook in server.ts. Defence in depth.
      res.status(400).json({ error: 'Empty request body' });
      return;
    }

    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp)) {
      res.status(401).json({ error: 'Invalid timestamp header' });
      return;
    }

    const replayWindow = Number(
      process.env.CRM_WEBHOOK_REPLAY_SECONDS ?? DEFAULT_REPLAY_WINDOW_SECONDS,
    );
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - timestamp) > replayWindow) {
      res.status(401).json({ error: 'Timestamp outside replay window' });
      return;
    }

    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');

    if (!constantTimeEquals(expected, signature)) {
      res.status(401).json({ error: 'Bad signature' });
      return;
    }

    r.crmTimestamp = timestamp;
    r.crmSignature = signature;
    next();
  };
}
