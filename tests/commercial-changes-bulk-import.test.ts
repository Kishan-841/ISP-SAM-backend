/**
 * POST /commercial-changes/bulk-import — bulk Excel upload (ADMIN-only).
 *
 * Covers:
 *   - All four change types commit happy path (UPGRADE / DOWNGRADE /
 *     RATE_REVISION / DISCONNECTION) when wired up correctly. Each one
 *     ends with `accounts.current_arc` updated and a `commercial_changes`
 *     row stamped with `accountAppliedAt`.
 *   - Per-row validation rejects bad rows but valid rows still commit
 *     (partial-success batch semantics).
 *   - Role gate (SAM gets 403).
 *   - Missing file payload (422).
 *   - Audit trail records the bulk source.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { app } from '../src/server.js';
import { prisma } from '../src/prisma.js';
import { resetDb, seedAccount, seedUser } from './helpers/db.js';
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

async function adminCookie(): Promise<{ id: string; cookie: string }> {
  const admin = await seedUser({ email: 'admin-bulk@x.com', role: 'ADMIN' });
  return { id: admin.id, cookie: `${SESSION_COOKIE}=${await tokenFor(admin.id, 'ADMIN')}` };
}

describe('POST /commercial-changes/bulk-import', () => {
  it('401 without cookie', async () => {
    const res = await request(app)
      .post('/commercial-changes/bulk-import')
      .attach('file', fixture('bulk-changes-mixed.csv'), 'changes.csv');
    expect(res.status).toBe(401);
  });

  it('403 for SAM (non-ADMIN)', async () => {
    const sam = await seedUser({ email: 'sam-bulk@x.com', role: 'SAM' });
    const cookie = `${SESSION_COOKIE}=${await tokenFor(sam.id, 'SAM')}`;
    const res = await request(app)
      .post('/commercial-changes/bulk-import')
      .set('Cookie', cookie)
      .attach('file', fixture('bulk-changes-mixed.csv'), 'changes.csv');
    expect(res.status).toBe(403);
  });

  it('422 with no file uploaded', async () => {
    const { cookie } = await adminCookie();
    const res = await request(app)
      .post('/commercial-changes/bulk-import')
      .set('Cookie', cookie);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/no file/i);
  });

  it('commits all four change types and writes commercial_changes + applies to account', async () => {
    const { id: adminId, cookie } = await adminCookie();
    // Four pre-seeded accounts that the CSV references. ARC values are
    // chosen so the CSV is self-consistent: UPGRADE goes up, DOWNGRADE
    // goes down, RATE_REVISION holds ARC, DISCONNECTION zeros out.
    const a1 = await seedAccount({ clientName: 'Up Co',   circuitId: 'CKT-100', currentArc: 500000, bandwidthMbps: 200 });
    const a2 = await seedAccount({ clientName: 'Down Co', circuitId: 'CKT-101', currentArc: 500000, bandwidthMbps: 200 });
    const a3 = await seedAccount({ clientName: 'Rate Co', circuitId: 'CKT-102', currentArc: 500000, bandwidthMbps: 100 });
    const a4 = await seedAccount({ clientName: 'Disc Co', circuitId: 'CKT-103', currentArc: 400000, bandwidthMbps: 50 });

    const res = await request(app)
      .post('/commercial-changes/bulk-import')
      .set('Cookie', cookie)
      .attach('file', fixture('bulk-changes-mixed.csv'), 'changes.csv');

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(4);
    expect(res.body.skipped).toBe(0);
    expect(res.body.appliedChanges).toHaveLength(4);

    // Account states reflect each change.
    const a1After = await prisma.account.findUnique({ where: { id: a1.id } });
    expect(Number(a1After!.currentArc)).toBe(800000);
    expect(a1After!.bandwidthMbps).toBe(500);
    expect(a1After!.contractStatus).toBe('ACTIVE');

    const a2After = await prisma.account.findUnique({ where: { id: a2.id } });
    expect(Number(a2After!.currentArc)).toBe(300000);

    const a3After = await prisma.account.findUnique({ where: { id: a3.id } });
    expect(Number(a3After!.currentArc)).toBe(500000); // unchanged
    expect(a3After!.bandwidthMbps).toBe(200); // bandwidth bumped

    const a4After = await prisma.account.findUnique({ where: { id: a4.id } });
    expect(Number(a4After!.currentArc)).toBe(0);
    expect(a4After!.contractStatus).toBe('TERMINATED');

    // commercial_changes rows exist, all stamped applied + BULK_LOCAL.
    const changes = await prisma.commercialChange.findMany({
      where: { accountId: { in: [a1.id, a2.id, a3.id, a4.id] } },
    });
    expect(changes).toHaveLength(4);
    for (const c of changes) {
      expect(c.accountAppliedAt).not.toBeNull();
      expect(c.crmStatus).toBe('BULK_LOCAL');
      expect(c.createdBy).toBe(adminId);
      expect(c.clientApprovalAttached).toBe(false);
    }
    // Disconnection row carries the resolved reason.
    const disc = changes.find((c) => c.changeType === 'DISCONNECTION');
    expect(disc!.disconnectionReason).toBe('office-closed');
  });

  it('writes audit_logs rows tagged BULK_IMPORT_COMMERCIAL_CHANGE with source=BULK_EXCEL', async () => {
    const { cookie } = await adminCookie();
    await seedAccount({ clientName: 'Up Co',   circuitId: 'CKT-100', currentArc: 500000, bandwidthMbps: 200 });
    await seedAccount({ clientName: 'Down Co', circuitId: 'CKT-101', currentArc: 500000, bandwidthMbps: 200 });
    await seedAccount({ clientName: 'Rate Co', circuitId: 'CKT-102', currentArc: 500000, bandwidthMbps: 100 });
    await seedAccount({ clientName: 'Disc Co', circuitId: 'CKT-103', currentArc: 400000, bandwidthMbps: 50 });

    await request(app)
      .post('/commercial-changes/bulk-import')
      .set('Cookie', cookie)
      .attach('file', fixture('bulk-changes-mixed.csv'), 'changes.csv');

    const audits = await prisma.auditLog.findMany({
      where: { action: 'BULK_IMPORT_COMMERCIAL_CHANGE' },
    });
    expect(audits).toHaveLength(4);
    for (const a of audits) {
      const p = a.payload as { source: string; note: string };
      expect(p.source).toBe('BULK_EXCEL');
      expect(p.note).toMatch(/Bulk-imported/i);
    }
  });

  it('partial success: invalid rows go into errors[], valid rows commit', async () => {
    const { cookie } = await adminCookie();
    // CSV has 7 rows:
    //   200 — valid UPGRADE (commits)
    //   MISSING — unknown_circuit
    //   201 — UPGRADE with newArc <= current (inconsistent_arc)
    //   202 — DOWNGRADE with newArc >= current (inconsistent_arc)
    //   203 — RATE_REVISION with newArc != current (inconsistent_arc)
    //   204 — DISCONNECTION with bad reason (invalid_disconnection_reason)
    //   205 — valid DISCONNECTION (commits)
    await seedAccount({ clientName: 'Good Up',     circuitId: 'CKT-200', currentArc: 500000, bandwidthMbps: 200 });
    await seedAccount({ clientName: 'Bad Up ARC',  circuitId: 'CKT-201', currentArc: 500000, bandwidthMbps: 200 });
    await seedAccount({ clientName: 'Bad Down',    circuitId: 'CKT-202', currentArc: 500000, bandwidthMbps: 200 });
    await seedAccount({ clientName: 'Bad Rate',    circuitId: 'CKT-203', currentArc: 500000, bandwidthMbps: 200 });
    await seedAccount({ clientName: 'Bad Reason',  circuitId: 'CKT-204', currentArc: 100000, bandwidthMbps: 50 });
    await seedAccount({ clientName: 'Good Disc',   circuitId: 'CKT-205', currentArc: 200000, bandwidthMbps: 50 });

    const res = await request(app)
      .post('/commercial-changes/bulk-import')
      .set('Cookie', cookie)
      .attach('file', fixture('bulk-changes-bad-rows.csv'), 'changes.csv');

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);
    expect(res.body.skipped).toBe(5);

    const errors: Array<{ kind: string; circuitId?: string }> = res.body.errors;
    const kinds = errors.map((e) => e.kind).sort();
    expect(kinds).toEqual(
      [
        'inconsistent_arc',
        'inconsistent_arc',
        'inconsistent_arc',
        'invalid_disconnection_reason',
        'unknown_circuit',
      ].sort(),
    );

    // Valid rows still applied.
    const goodUp = await prisma.account.findFirst({ where: { circuitId: 'CKT-200' } });
    expect(Number(goodUp!.currentArc)).toBe(800000);
    const goodDisc = await prisma.account.findFirst({ where: { circuitId: 'CKT-205' } });
    expect(goodDisc!.contractStatus).toBe('TERMINATED');
    expect(Number(goodDisc!.currentArc)).toBe(0);

    // Invalid rows untouched.
    const badUp = await prisma.account.findFirst({ where: { circuitId: 'CKT-201' } });
    expect(Number(badUp!.currentArc)).toBe(500000);
  });

  it('strips Mbps suffix on New Bandwidth — CRM exports routinely include "100 Mbps"', async () => {
    // The user's CRM export ships New Bandwidth cells as "150Mbps", "200 Mbps",
    // "150  mbps" — none of which are valid Number() inputs. The importer
    // tolerates them by stripping the trailing unit before parsing.
    const { cookie } = await adminCookie();
    await seedAccount({ clientName: 'A', circuitId: 'CKT-300', currentArc: 500000, bandwidthMbps: 200 });
    await seedAccount({ clientName: 'B', circuitId: 'CKT-301', currentArc: 200000, bandwidthMbps: 100 });
    await seedAccount({ clientName: 'C', circuitId: 'CKT-302', currentArc: 400000, bandwidthMbps: 100 });

    const res = await request(app)
      .post('/commercial-changes/bulk-import')
      .set('Cookie', cookie)
      .attach('file', fixture('bulk-changes-with-mbps-suffix.csv'), 'changes.csv');

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(3);
    expect(res.body.skipped).toBe(0);

    // Account bandwidths get the numeric value, suffix stripped.
    const after = await prisma.account.findMany({
      where: { circuitId: { in: ['CKT-300', 'CKT-301', 'CKT-302'] } },
      orderBy: { circuitId: 'asc' },
    });
    expect(after.map((a) => a.bandwidthMbps)).toEqual([500, 200, 150]);
  });

  it('DISCONNECTION rows commit when disconnection reason is empty', async () => {
    // The per-row form requires a reason interactively, but bulk imports
    // come from historical exports where the reason column is often blank.
    // We accept missing reason on bulk to avoid rejecting otherwise-valid
    // historical termination rows.
    const { cookie } = await adminCookie();
    await seedAccount({ clientName: 'No Reason Disc', circuitId: 'CKT-400', currentArc: 400000, bandwidthMbps: 50 });

    const res = await request(app)
      .post('/commercial-changes/bulk-import')
      .set('Cookie', cookie)
      .attach('file', fixture('bulk-changes-disco-no-reason.csv'), 'changes.csv');

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toBe(0);

    const after = await prisma.account.findFirst({ where: { circuitId: 'CKT-400' } });
    expect(after!.contractStatus).toBe('TERMINATED');
    expect(Number(after!.currentArc)).toBe(0);
    const change = await prisma.commercialChange.findFirst({ where: { accountId: after!.id } });
    expect(change!.changeType).toBe('DISCONNECTION');
    expect(change!.disconnectionReason).toBeNull();
  });

  it('rejects rows whose account is already TERMINATED', async () => {
    const { cookie } = await adminCookie();
    await seedAccount({
      clientName: 'Dead Co',
      circuitId: 'CKT-100',
      currentArc: 0,
      contractStatus: 'TERMINATED',
    });
    // Other rows in the CSV reference accounts that don't exist, which is
    // fine — we're only checking the CKT-100 row's terminated-guard fires.
    const res = await request(app)
      .post('/commercial-changes/bulk-import')
      .set('Cookie', cookie)
      .attach('file', fixture('bulk-changes-mixed.csv'), 'changes.csv');

    expect(res.status).toBe(200);
    const ckt100Err = res.body.errors.find(
      (e: { circuitId?: string }) => e.circuitId === 'CKT-100',
    );
    expect(ckt100Err).toBeDefined();
    expect(ckt100Err.kind).toBe('account_terminated');
  });
});
