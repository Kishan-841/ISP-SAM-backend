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
    // ARC is required, so the missing-ARC row also fails.
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

  it('sets startOfPeriodArc on create equal to imported currentArc', async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post('/accounts/import')
      .set('Cookie', cookie)
      .attach('file', fixture('valid.csv'), 'valid.csv');
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(3);
    const list = await request(app).get('/accounts').set('Cookie', cookie);
    for (const acc of list.body.accounts) {
      expect(Number(acc.startOfPeriodArc)).toBe(Number(acc.currentArc));
    }
  });

  it('returns preview rows for created + updated, with categorised error kinds', async () => {
    const cookie = await adminCookie();

    // First import the valid 3-row file — all created.
    const first = await request(app)
      .post('/accounts/import')
      .set('Cookie', cookie)
      .attach('file', fixture('valid.csv'), 'valid.csv');
    expect(first.status).toBe(200);
    expect(first.body.imported).toBe(3);
    expect(first.body.updated).toBe(0);
    expect(first.body.createdAccounts).toHaveLength(3);
    expect(first.body.updatedAccounts).toHaveLength(0);
    // Preview row shape — what the UI consumes.
    const sample = first.body.createdAccounts[0];
    expect(sample).toMatchObject({
      rowNumber: expect.any(Number),
      accountId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      clientName: expect.any(String),
      currentArc: expect.any(Number),
      kittyType: expect.stringMatching(/^(BASE|NEW)$/),
      contractStatus: expect.any(String),
    });

    // Re-import with reimport.csv — one row overlaps on leadId (update path),
    // rest are new (create path). Confirms both preview arrays populate.
    const second = await request(app)
      .post('/accounts/import')
      .set('Cookie', cookie)
      .attach('file', fixture('reimport.csv'), 'reimport.csv');
    expect(second.body.updatedAccounts.length).toBe(second.body.updated);
    expect(second.body.createdAccounts.length).toBe(second.body.imported);

    // Now exercise the error-categorisation path with the missing-required fixture.
    const bad = await request(app)
      .post('/accounts/import')
      .set('Cookie', cookie)
      .attach('file', fixture('missing-required.csv'), 'missing-required.csv');
    expect(bad.body.errors.length).toBeGreaterThan(0);
    for (const e of bad.body.errors) {
      expect(['missing_field', 'invalid_value', 'duplicate', 'other']).toContain(e.kind);
    }
    // At least one row should be flagged as missing_field given the fixture's name.
    expect(bad.body.errors.some((e: { kind: string }) => e.kind === 'missing_field')).toBe(true);
  });

  it('imports the Email column onto accounts.email (trims whitespace, treats blank as null)', async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post('/accounts/import')
      .set('Cookie', cookie)
      .attach('file', fixture('with-email.csv'), 'with-email.csv');
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(3);

    const list = await request(app).get('/accounts').set('Cookie', cookie);
    const byLead = new Map(
      (list.body.accounts as Array<{ leadId: string; email: string | null }>).map((a) => [
        a.leadId,
        a.email,
      ]),
    );
    expect(byLead.get('LEAD-EMAIL-1')).toBe('eva@example.com');
    // Whitespace must be trimmed by the importer.
    expect(byLead.get('LEAD-EMAIL-2')).toBe('frank@example.com');
    // Empty cell stays null on the account, not ''.
    expect(byLead.get('LEAD-EMAIL-3')).toBeNull();
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
