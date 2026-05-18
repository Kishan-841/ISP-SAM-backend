import crypto from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../src/server.js';
import { prisma } from '../src/prisma.js';
import { resetDb } from './helpers/db.js';

const TEST_SECRET = 'test-only-crm-webhook-secret-32chars-minimum';

beforeAll(() => {
  process.env.CRM_WEBHOOK_SECRET = TEST_SECRET;
  process.env.CRM_WEBHOOK_REPLAY_SECONDS = '300';
});

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  await resetDb();
});

type Payload = ReturnType<typeof samplePayload>;

function samplePayload(overrides: Partial<{ eventId: string; companyName: string; externalId: string; currentArc: number }> = {}) {
  return {
    eventId: overrides.eventId ?? crypto.randomUUID(),
    eventType: 'customer.activated' as const,
    occurredAt: new Date().toISOString(),
    customer: {
      externalId: overrides.externalId ?? `lead-${crypto.randomUUID().slice(0, 8)}`,
      companyName: overrides.companyName ?? 'HealthPlus Hospitals',
      contactName: 'Priya Nair',
      email: 'ops@healthplus.in',
      phone: '+919999999999',
      circuitId: `CKT-${Math.floor(Math.random() * 10000)}`,
      bandwidthMbps: 100,
      currentPlan: 'Enterprise 100Mbps',
      currentArc: overrides.currentArc ?? 600000,
      onboardingDate: '2026-05-02',
    },
  };
}

function sign(payload: Payload, secret = TEST_SECRET, timestampSeconds?: number) {
  const ts = timestampSeconds ?? Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.`)
    .update(body)
    .digest('hex');
  return { body, signature, ts };
}

function postWebhook(payload: Payload, opts: { secret?: string; ts?: number } = {}) {
  const { body, signature, ts } = sign(payload, opts.secret, opts.ts);
  return request(app)
    .post('/integrations/crm/customer-activated')
    .set('Content-Type', 'application/json')
    .set('X-CRM-Signature', signature)
    .set('X-CRM-Timestamp', String(ts))
    .send(body);
}

describe('POST /integrations/crm/customer-activated', () => {
  describe('happy path', () => {
    it('creates a NEW kitty Account, records IntegrationEvent, returns 201', async () => {
      const payload = samplePayload();
      const res = await postWebhook(payload);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('processed');
      expect(res.body.accountId).toBeDefined();

      const account = await prisma.account.findUnique({
        where: { externalCrmId: payload.customer.externalId },
      });
      expect(account).not.toBeNull();
      expect(account?.kittyType).toBe('NEW');
      expect(account?.contractStatus).toBe('ACTIVE');
      expect(account?.companyName).toBe('HealthPlus Hospitals');
      expect(account?.clientName).toBe('Priya Nair');
      expect(Number(account?.currentArc)).toBe(600000);
      expect(account?.bandwidthMbps).toBe(100);
      expect(account?.email).toBe('ops@healthplus.in');
      expect(account?.mobileNumber).toBe('+919999999999');

      const event = await prisma.integrationEvent.findUnique({
        where: { externalEventId: payload.eventId },
      });
      expect(event?.status).toBe('PROCESSED');
      expect(event?.accountId).toBe(account?.id);
      expect(event?.signatureHeader).toBeTruthy();
    });

    it('accepts legacy currentMrr (monthly) and stores it as currentArc × 12', async () => {
      const payload = samplePayload();
      // Drop currentArc, send currentMrr instead.
      const variant = {
        ...payload,
        customer: {
          ...payload.customer,
          currentArc: undefined as unknown as number,
          currentMrr: 50000, // ₹50K/month → ₹6L/year
        },
      } as Payload;
      const res = await postWebhook(variant);
      expect(res.status).toBe(201);
      const account = await prisma.account.findUnique({
        where: { externalCrmId: variant.customer.externalId },
      });
      expect(Number(account?.currentArc)).toBe(600000);
    });

    it('rejects payload missing both currentArc and currentMrr', async () => {
      const payload = samplePayload();
      const variant = {
        ...payload,
        customer: {
          ...payload.customer,
          currentArc: undefined as unknown as number,
        },
      } as Payload;
      const res = await postWebhook(variant);
      expect(res.status).toBe(400);
    });

    it('updates an existing Account on subsequent activation events', async () => {
      const externalId = `lead-${crypto.randomUUID()}`;
      await postWebhook(samplePayload({ externalId, currentArc: 360000 }));
      await postWebhook(
        samplePayload({ externalId, currentArc: 540000, companyName: 'HealthPlus Hospitals Pvt Ltd' }),
      );
      const accounts = await prisma.account.findMany({
        where: { externalCrmId: externalId },
      });
      expect(accounts).toHaveLength(1);
      expect(Number(accounts[0]!.currentArc)).toBe(540000);
      expect(accounts[0]!.companyName).toBe('HealthPlus Hospitals Pvt Ltd');
      // startOfPeriodArc is captured ONCE on the first activation and never
      // overwritten — even when a subsequent webhook arrives with a different
      // currentArc. This is what lets dashboards show the "since onboarding"
      // delta correctly.
      expect(Number(accounts[0]!.startOfPeriodArc)).toBe(360000);
    });

    it('captures startOfPeriodArc on first activation', async () => {
      const payload = samplePayload();
      await postWebhook(payload);
      const account = await prisma.account.findUnique({
        where: { externalCrmId: payload.customer.externalId },
      });
      expect(Number(account?.startOfPeriodArc)).toBe(600000);
      expect(Number(account?.currentArc)).toBe(600000);
    });
  });

  describe('failure capture', () => {
    it('records a human-readable status_reason when circuit_id collides', async () => {
      // First customer claims a circuit ID.
      const first = samplePayload({ externalId: 'lead-first' });
      first.customer.circuitId = 'CKT-COLLIDE';
      first.customer.companyName = 'First Tenant Ltd';
      const firstRes = await postWebhook(first);
      expect(firstRes.status).toBe(201);

      // Second customer (different externalId) tries to use the same circuit.
      const second = samplePayload({ externalId: 'lead-second' });
      second.customer.circuitId = 'CKT-COLLIDE';
      const secondRes = await postWebhook(second);
      // Re-thrown so the CRM gets a 5xx and can decide whether to retry.
      expect(secondRes.status).toBeGreaterThanOrEqual(500);

      const events = await prisma.integrationEvent.findMany({
        where: { externalEventId: second.eventId },
      });
      expect(events).toHaveLength(1);
      const evt = events[0]!;
      expect(evt.status).toBe('FAILED');
      // Reason should pinpoint the conflict and name the existing owner so
      // an admin can fix it from the audit row alone.
      expect(evt.statusReason).toMatch(/circuit_id/i);
      expect(evt.statusReason).toMatch(/CKT-COLLIDE/);
      expect(evt.statusReason).toMatch(/First Tenant Ltd/);

      // No second account row should have been created.
      const accounts = await prisma.account.findMany({
        where: { circuitId: 'CKT-COLLIDE' },
      });
      expect(accounts).toHaveLength(1);
      expect(accounts[0]!.externalCrmId).toBe('lead-first');
    });
  });

  describe('idempotency', () => {
    it('returns 200 already_processed on duplicate eventId, no second Account', async () => {
      const payload = samplePayload();
      const first = await postWebhook(payload);
      expect(first.status).toBe(201);

      const second = await postWebhook(payload);
      expect(second.status).toBe(200);
      expect(second.body.status).toBe('already_processed');
      expect(second.body.accountId).toBe(first.body.accountId);

      const accounts = await prisma.account.findMany({
        where: { externalCrmId: payload.customer.externalId },
      });
      expect(accounts).toHaveLength(1);

      const events = await prisma.integrationEvent.findMany({
        where: { externalEventId: payload.eventId },
      });
      expect(events).toHaveLength(1);
    });
  });

  describe('signature verification', () => {
    it('rejects requests with a tampered body (signature mismatch)', async () => {
      const payload = samplePayload();
      const { signature, ts } = sign(payload);
      const tamperedBody = JSON.stringify({
        ...payload,
        customer: { ...payload.customer, currentArc: 999_999_999 },
      });
      const res = await request(app)
        .post('/integrations/crm/customer-activated')
        .set('Content-Type', 'application/json')
        .set('X-CRM-Signature', signature)
        .set('X-CRM-Timestamp', String(ts))
        .send(tamperedBody);

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/bad signature/i);
      // The specific event must not have been recorded — the rejection
      // happens in middleware before the rejection-logger runs.
      const event = await prisma.integrationEvent.findUnique({
        where: { externalEventId: payload.eventId },
      });
      expect(event).toBeNull();
      const account = await prisma.account.findUnique({
        where: { externalCrmId: payload.customer.externalId },
      });
      expect(account).toBeNull();
    });

    it('rejects requests signed with the wrong secret', async () => {
      const res = await postWebhook(samplePayload(), { secret: 'wrong-secret' });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/bad signature/i);
    });

    it('rejects requests with no signature header', async () => {
      const res = await request(app)
        .post('/integrations/crm/customer-activated')
        .set('X-CRM-Timestamp', String(Math.floor(Date.now() / 1000)))
        .send(samplePayload());
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/missing signature headers/i);
    });

    it('rejects requests with no timestamp header', async () => {
      const payload = samplePayload();
      const { signature } = sign(payload);
      const res = await request(app)
        .post('/integrations/crm/customer-activated')
        .set('Content-Type', 'application/json')
        .set('X-CRM-Signature', signature)
        .send(JSON.stringify(payload));
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/missing signature headers/i);
    });
  });

  describe('replay protection', () => {
    it('rejects timestamps older than the replay window', async () => {
      const tooOld = Math.floor(Date.now() / 1000) - 600; // 10 min ago, window is 5 min
      const res = await postWebhook(samplePayload(), { ts: tooOld });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/replay window/i);
    });

    it('rejects timestamps too far in the future', async () => {
      const tooFuture = Math.floor(Date.now() / 1000) + 600;
      const res = await postWebhook(samplePayload(), { ts: tooFuture });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /integrations/events (admin log)', () => {
    it('401 without an auth cookie', async () => {
      const res = await request(app).get('/integrations/events');
      expect(res.status).toBe(401);
    });

    it('403 for non-admin authenticated users', async () => {
      const { seedUser } = await import('./helpers/db.js');
      const { tokenFor } = await import('./helpers/auth.js');
      const { SESSION_COOKIE } = await import('../src/lib/jwt.js');
      const sam = await seedUser({ email: 'sam@x.com', role: 'SAM' });
      const token = await tokenFor(sam.id, 'SAM');
      const res = await request(app)
        .get('/integrations/events')
        .set('Cookie', `${SESSION_COOKIE}=${token}`);
      expect(res.status).toBe(403);
    });

    it('returns recent events newest-first with status filter', async () => {
      const { seedUser } = await import('./helpers/db.js');
      const { tokenFor } = await import('./helpers/auth.js');
      const { SESSION_COOKIE } = await import('../src/lib/jwt.js');
      const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
      const token = await tokenFor(admin.id, 'ADMIN');
      const adminCookie = `${SESSION_COOKIE}=${token}`;

      // 1 successful + 1 duplicate of the same event
      const payload = samplePayload();
      await postWebhook(payload);
      await postWebhook(payload);
      // 1 rejected (validation)
      await postWebhook({ ...samplePayload(), customer: { externalId: 'x', currentArc: 12, onboardingDate: '2026-01-01' } } as Payload);

      const allRes = await request(app).get('/integrations/events').set('Cookie', adminCookie);
      expect(allRes.status).toBe(200);
      expect(allRes.body.events.length).toBeGreaterThanOrEqual(2);
      expect(allRes.body.total).toBeGreaterThanOrEqual(2);

      const procRes = await request(app)
        .get('/integrations/events?status=PROCESSED')
        .set('Cookie', adminCookie);
      expect(procRes.status).toBe(200);
      for (const ev of procRes.body.events) {
        expect(ev.status).toBe('PROCESSED');
      }

      const rejRes = await request(app)
        .get('/integrations/events?status=REJECTED')
        .set('Cookie', adminCookie);
      for (const ev of rejRes.body.events) {
        expect(ev.status).toBe('REJECTED');
        expect(ev.statusReason).toBeTruthy();
      }
    });
  });

  describe('payload validation', () => {
    it('returns 400 when required fields are missing', async () => {
      const bad = {
        eventId: crypto.randomUUID(),
        eventType: 'customer.activated' as const,
        occurredAt: new Date().toISOString(),
        customer: {
          externalId: 'lead-xyz',
          // companyName intentionally missing
          currentArc: 120000,
          onboardingDate: '2026-05-02',
        },
      } as unknown as Payload;
      const res = await postWebhook(bad);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/validation/i);
      // Rejection is logged with the supplied eventId for forensics.
      const event = await prisma.integrationEvent.findUnique({
        where: { externalEventId: bad.eventId },
      });
      expect(event?.status).toBe('REJECTED');
    });

    it('returns 400 for non-uuid eventId', async () => {
      const bad = { ...samplePayload(), eventId: 'not-a-uuid' };
      const res = await postWebhook(bad as Payload);
      expect(res.status).toBe(400);
    });
  });
});
