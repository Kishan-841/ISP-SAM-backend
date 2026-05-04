# SAM — Backend

Service Assurance Manager (SAM) backend. Express + Prisma + Postgres.
Standalone from the existing ISP CRM (`crm.gazonindia.com`); receives
new-customer activations from the CRM via a signed inbound webhook.

Pairs with: **sam-frontend** (Next.js, deployed on Vercel).

## Tech

- Node 20+ · Express 5
- Prisma 6 · Postgres 14+
- JOSE JWT (HTTP-only cookie auth) · bcryptjs
- Multer (commercial-change approval uploads)
- Vitest + Supertest

## Local development

```bash
pnpm install
cp .env.example .env

# Bring up two Postgres databases (sam_dev + sam_test).
# Adjust DATABASE_URL / DATABASE_URL_TEST in .env first.
pnpm exec prisma migrate dev          # apply migrations to sam_dev
DATABASE_URL="$DATABASE_URL_TEST" pnpm exec prisma migrate deploy   # to sam_test

pnpm dev                               # listens on http://localhost:5500
```

The backend uses **port 5500** locally (not 5000) so it can coexist with
the live CRM backend on a single dev laptop.

## Tests

```bash
pnpm test                # full vitest suite (127 tests)
pnpm test --run <pattern>  # filter
```

## CRM ↔ SAM webhook

When a plan is activated in the CRM, it POSTs to:

```
POST /integrations/crm/customer-activated
Content-Type: application/json
X-CRM-Signature: <hmac-sha256(shared-secret, `${ts}.${rawBody}`)>
X-CRM-Timestamp: <unix seconds>
```

SAM verifies the HMAC + timestamp window, idempotency-checks the `eventId`,
and upserts the customer as `kittyType=NEW` in `accounts`. Every receive
(accepted, duplicate, or rejected) is logged to `integration_events` for
forensic audit. See `INTEGRATION.md` (in repo root or shared spec) and
`scripts/mock-crm.ts` for the wire contract.

## Deployment — Docker on the VM

This backend deploys as a Docker service alongside Postgres on the Gazon
VM. The frontend lives on Vercel and hits this backend over HTTPS via a
subdomain (e.g. `sam.gazonindia.com`).

**Status: deployment artefacts (Dockerfile, docker-compose.yml, nginx
config, DEPLOY.md) will be added in a follow-up commit.** They aren't in
this initial push because we want the application code to be the source
of truth before the build/deploy plumbing is layered on.

### Required environment for production

See `.env.example`. The critical ones:

- `DATABASE_URL` — points at the docker-compose postgres service
- `JWT_SECRET` — a fresh 32+ char string per environment
- `CRM_WEBHOOK_SECRET` — must match what the CRM has configured
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — first-boot admin

## Project structure

```
prisma/                 Schema + migrations + (later) seed data
  schema.prisma
  migrations/
src/
  server.ts             Express app + middleware mount
  prisma.ts             Prisma client singleton
  lib/                  jwt, kitty (April-1 cutoff), shared utilities
  middlewares/          error-handler
  modules/
    auth/               login, session, password change, requireAuth + requireRole
    accounts/           accounts CRUD + Excel import
    commercial-changes/ hard-gate commercial change flow + audit
    dashboard/          existingBase / newBase metrics
    integrations/       CRM webhook receiver + admin event log
    leaderboard/        SAM Reliability Index
    meetings/           meeting + MOM management
    users/              SAM user CRUD
scripts/
  mock-crm.ts           Reference implementation of the CRM-side caller
                        (manual smoke testing for the webhook bridge)
tests/                  Vitest suites
uploads/                Persisted commercial-change approval files
                        (mounted as a Docker volume in production)
```
