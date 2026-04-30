import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { app } from '../src/server.js';
import { resetDb, seedUser } from './helpers/db.js';
import { tokenFor } from './helpers/auth.js';
import { SESSION_COOKIE } from '../src/lib/jwt.js';

const FIXTURES = path.resolve(__dirname, 'fixtures');
function fixture(name: string) {
  return readFileSync(path.join(FIXTURES, name));
}

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});

beforeEach(async () => {
  await resetDb();
});

async function adminCookie() {
  const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
  return `${SESSION_COOKIE}=${await tokenFor(admin.id, 'ADMIN')}`;
}

describe('POST /accounts/import', () => {
  it('401 without cookie', async () => {
    const res = await request(app)
      .post('/accounts/import')
      .attach('file', fixture('valid.csv'), 'valid.csv');
    expect(res.status).toBe(401);
  });

  it('403 when SAM tries to import', async () => {
    const sam = await seedUser({ email: 'sam@x.com', role: 'SAM' });
    const cookie = `${SESSION_COOKIE}=${await tokenFor(sam.id, 'SAM')}`;
    const res = await request(app)
      .post('/accounts/import')
      .set('Cookie', cookie)
      .attach('file', fixture('valid.csv'), 'valid.csv');
    expect(res.status).toBe(403);
  });

  it('400 when no file is attached', async () => {
    const cookie = await adminCookie();
    const res = await request(app).post('/accounts/import').set('Cookie', cookie);
    expect(res.status).toBe(400);
  });

  it('imports a valid CSV with 3 rows and reports summary', async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post('/accounts/import')
      .set('Cookie', cookie)
      .attach('file', fixture('valid.csv'), 'valid.csv');
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(3);
    expect(res.body.updated).toBe(0);
    expect(res.body.skipped).toBe(0);
    expect(res.body.errors).toEqual([]);
  });

  it('puts unknown columns into metadata', async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post('/accounts/import')
      .set('Cookie', cookie)
      .attach('file', fixture('extra-cols.csv'), 'extra-cols.csv');
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    // Verify metadata persisted
    const list = await request(app).get('/accounts').set('Cookie', cookie);
    expect(list.body.accounts).toHaveLength(1);
    expect(list.body.accounts[0].metadata).toMatchObject({
      Industry: 'Manufacturing',
      Region: 'North',
      'SLA Tier': 'Gold-24x7',
    });
  });

  it('skips rows missing required fields and reports errors', async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post('/accounts/import')
      .set('Cookie', cookie)
      .attach('file', fixture('missing-required.csv'), 'missing-required.csv');
    expect(res.status).toBe(200);
    // MRR/ARC is required, so the missing-ARC row also fails.
    // Row 2: missing name, Row 3: missing ARC, Row 4: missing date.
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped).toBe(3);
    expect(res.body.errors).toHaveLength(3);
    expect(res.body.errors[0].rowNumber).toBe(2);
  });

  it("aliases status 'Closed' to TERMINATED", async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post('/accounts/import')
      .set('Cookie', cookie)
      .attach('file', fixture('with-bandwidth-and-aliases.csv'), 'with-bandwidth-and-aliases.csv');
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    const list = await request(app).get('/accounts').set('Cookie', cookie);
    const acc = list.body.accounts.find((a: { leadId: string }) => a.leadId === 'LEAD-CLOSED');
    expect(acc).toBeDefined();
    expect(acc.contractStatus).toBe('TERMINATED');
  });

  it('auto-generates customerCode and circuitId on create', async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post('/accounts/import')
      .set('Cookie', cookie)
      .attach('file', fixture('with-bandwidth-and-aliases.csv'), 'with-bandwidth-and-aliases.csv');
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    const list = await request(app).get('/accounts').set('Cookie', cookie);
    const acc = list.body.accounts.find((a: { leadId: string }) => a.leadId === 'LEAD-CLOSED');
    expect(acc).toBeDefined();
    expect(acc.customerCode).toMatch(/^GAZ-\d{4}$/);
    expect(acc.circuitId).toMatch(/^CKT-\d{4}$/);
  });

  it('stores bandwidthMbps when present', async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post('/accounts/import')
      .set('Cookie', cookie)
      .attach('file', fixture('with-bandwidth-and-aliases.csv'), 'with-bandwidth-and-aliases.csv');
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    const list = await request(app).get('/accounts').set('Cookie', cookie);
    const acc = list.body.accounts.find((a: { leadId: string }) => a.leadId === 'LEAD-CLOSED');
    expect(acc).toBeDefined();
    expect(acc.bandwidthMbps).toBe(100);
  });

  it('sets startOfPeriodMrr on create equal to imported currentMrr', async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post('/accounts/import')
      .set('Cookie', cookie)
      .attach('file', fixture('valid.csv'), 'valid.csv');
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(3);
    const list = await request(app).get('/accounts').set('Cookie', cookie);
    for (const acc of list.body.accounts) {
      expect(Number(acc.startOfPeriodMrr)).toBe(Number(acc.currentMrr));
    }
  });

  it('updates existing rows on re-import (idempotent on leadId)', async () => {
    const cookie = await adminCookie();

    // First import
    const first = await request(app)
      .post('/accounts/import')
      .set('Cookie', cookie)
      .attach('file', fixture('valid.csv'), 'valid.csv');
    expect(first.body.imported).toBe(3);

    // Re-import with one overlapping leadId
    const second = await request(app)
      .post('/accounts/import')
      .set('Cookie', cookie)
      .attach('file', fixture('reimport.csv'), 'reimport.csv');
    expect(second.body.imported).toBe(0);
    expect(second.body.updated).toBe(1);

    // Verify the update took effect (Plan changed from "Gold" to "Diamond")
    const list = await request(app).get('/accounts').set('Cookie', cookie);
    const updated = list.body.accounts.find((a: { leadId: string }) => a.leadId === 'LEAD-100');
    expect(updated.currentPlan).toBe('Diamond');
    expect(updated.clientName).toBe('Alice Co Updated');
  });
});
