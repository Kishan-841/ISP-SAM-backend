import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { resetDb, seedAccount, seedUser } from './helpers/db.js';
import { tokenFor, authedGet } from './helpers/auth.js';

/**
 * Cursor pagination on GET /accounts.
 *
 * Default page size 500, hard cap 1000. Response shape:
 *   { accounts: [...], nextCursor: string | null }
 *
 * The cursor is the id of the last row returned. Pass it back as
 * `?cursor=...` to get the next page. When there are no more rows,
 * `nextCursor` is null.
 */
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});
beforeEach(async () => {
  await resetDb();
});

describe('GET /accounts pagination', () => {
  it('respects `limit` and returns nextCursor when more rows exist', async () => {
    const admin = await seedUser({ email: 'admin-pg@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    // 5 accounts. Page size 3 → first page returns 3 + nextCursor.
    for (let i = 0; i < 5; i++) {
      await seedAccount({ clientName: `Co-${i}` });
    }

    const page1 = await authedGet(app, '/accounts?limit=3', token);
    expect(page1.status).toBe(200);
    expect(page1.body.accounts).toHaveLength(3);
    expect(page1.body.nextCursor).toBeTruthy();
    expect(typeof page1.body.nextCursor).toBe('string');
  });

  it('returns nextCursor=null on the final page', async () => {
    const admin = await seedUser({ email: 'admin-pg2@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    for (let i = 0; i < 4; i++) {
      await seedAccount({ clientName: `Co-${i}` });
    }

    const res = await authedGet(app, '/accounts?limit=10', token);
    expect(res.body.accounts).toHaveLength(4);
    expect(res.body.nextCursor).toBeNull();
  });

  it('seeks past the cursor and returns no duplicates across pages', async () => {
    const admin = await seedUser({ email: 'admin-pg3@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    const seeded = [];
    for (let i = 0; i < 7; i++) {
      seeded.push(await seedAccount({ clientName: `Co-${i}` }));
    }

    // Walk through all pages with size 3.
    const all: { id: string; clientName: string }[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: { body: { accounts: { id: string; clientName: string }[]; nextCursor: string | null } } =
        await authedGet(app, `/accounts?limit=3${cursor ? `&cursor=${cursor}` : ''}`, token);
      all.push(...res.body.accounts);
      cursor = res.body.nextCursor;
      pages++;
      if (pages > 10) throw new Error('Pagination loop did not terminate');
    } while (cursor !== null);

    expect(all).toHaveLength(7);
    expect(pages).toBe(3); // 3 + 3 + 1
    // No duplicate ids across pages.
    const ids = all.map((a) => a.id);
    expect(new Set(ids).size).toBe(7);
    // All seeded accounts appear.
    for (const a of seeded) {
      expect(ids).toContain(a.id);
    }
  });

  it('defaults to 500 limit when no limit param is sent', async () => {
    const admin = await seedUser({ email: 'admin-pg4@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    for (let i = 0; i < 3; i++) {
      await seedAccount({ clientName: `Co-${i}` });
    }
    const res = await authedGet(app, '/accounts', token);
    expect(res.body.accounts).toHaveLength(3);
    expect(res.body.nextCursor).toBeNull(); // fewer than 500 rows
  });

  it('caps oversize limits to 1000 (no DoS via huge limit)', async () => {
    const admin = await seedUser({ email: 'admin-pg5@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    await seedAccount({ clientName: 'A' });
    const res = await authedGet(app, '/accounts?limit=100000', token);
    // No error — just clamped to 1000 internally. The single seeded row returns.
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
  });

  it('respects SAM scoping across pages (only own customers)', async () => {
    const sam1 = await seedUser({ email: 'sam1-pg@x.com', role: 'SAM' });
    const sam2 = await seedUser({ email: 'sam2-pg@x.com', role: 'SAM' });
    for (let i = 0; i < 3; i++) {
      await seedAccount({ clientName: `Mine-${i}`, samOwnerId: sam1.id });
    }
    for (let i = 0; i < 3; i++) {
      await seedAccount({ clientName: `Theirs-${i}`, samOwnerId: sam2.id });
    }

    const token = await tokenFor(sam1.id, 'SAM');
    const all: { id: string; clientName: string }[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: { accounts: { id: string; clientName: string }[]; nextCursor: string | null } } =
        await authedGet(app, `/accounts?limit=2${cursor ? `&cursor=${cursor}` : ''}`, token);
      all.push(...res.body.accounts);
      cursor = res.body.nextCursor;
    } while (cursor !== null);

    expect(all).toHaveLength(3);
    for (const a of all) {
      expect(a.clientName.startsWith('Mine-')).toBe(true);
    }
  });
});
