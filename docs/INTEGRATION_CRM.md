# CRM ↔ SAM Integration — Disconnection Categories

**Audience:** CRM team
**Owner:** SAM platform
**Status:** Required for the SAM → CRM disconnection bridge to function.

---

## What's broken right now

When SAM raises a disconnection on a CRM-synced customer (the day-21 "Proceed" decision in the retention queue), SAM POSTs a service-order to the CRM:

```
POST /api/service-orders
{
  "customerId":                 "<externalCrmId>",
  "orderType":                  "DISCONNECTION",
  "disconnectionCategoryId":    "<slug>",
  "disconnectionSubCategoryId": "<slug>",
  "disconnectionReason":        "<optional free text>",
  "approvalFileUrl":            "<cloudinary url>",
  "poFileUrl":                  "<cloudinary url>",
  "mailReceivedDate":           "2026-05-13",            // NEW (2026-05-13) — ISO date
  "notes":                      "SAM-XXXXXXXX | Reason: <category> — <sub> | Details: <reason>"
}
```

> **New field — `mailReceivedDate`** (added 2026-05-13): the date SAM
> received the customer's approval email. Sent on **every** order type
> (UPGRADE / DOWNGRADE / RATE_REVISION / DISCONNECTION). ISO date only, no
> time component. Optional in the API for back-compat, but the SAM form
> requires it for new commits — expect it to be present on every new
> service order. Please render it on the CRM order detail UI so the ops
> team can see when the customer actually consented.

The CRM currently responds:

```
HTTP/1.1 400 Bad Request
{ "message": "Invalid disconnection category or sub-category." }
```

Two findings from our investigation:

1. `GET /api/service-orders/disconnection-reasons` returns `{ "data": [] }` — the CRM-side category table is empty.
2. The validator on `POST /api/service-orders` rejects any `disconnectionCategoryId` / `disconnectionSubCategoryId` that isn't in that table.

Until the CRM seeds the categories, no disconnection raised in SAM can hand off to the CRM, and both systems drift out of sync (SAM disconnects on day 31, CRM still shows the customer as active).

---

## What SAM needs from the CRM

SAM owns the disconnection-reason taxonomy now (the SAM UI used to fetch it from CRM, but operations asked for a SAM-owned policy list). The CRM needs to **seed matching rows** in its `disconnection_categories` and `disconnection_sub_categories` tables, using the **exact slug IDs** below.

### Categories (5 rows)

| `id` (string) | `name` | `isActive` |
| --- | --- | --- |
| `office-closed` | Office Closed | true |
| `project-closed` | Project Closed | true |
| `commercial-issue` | Commercial Issue | true |
| `management-call` | Management Call | true |
| `service-issue` | Service Issue | true |

### Sub-categories (10 rows)

| `id` (string) | `categoryId` (FK) | `name` | `isActive` |
| --- | --- | --- | --- |
| `office-closed` | `office-closed` | Office Closed | true |
| `project-handovered-closed` | `project-closed` | Project Handovered / Closed | true |
| `moved-for-better-pricing` | `commercial-issue` | Moved for Better Pricing | true |
| `shifted-to-broadband` | `commercial-issue` | Shifted to Broadband | true |
| `company-in-crisis-business-downfall` | `commercial-issue` | Company in Crisis / Business Downfall | true |
| `shifted-to-telcom` | `management-call` | Shifted to Telcom (TTL / Airtel / Voda) | true |
| `wants-single-isp` | `management-call` | Wants Single ISP | true |
| `moved-to-coworking` | `management-call` | Moved to Coworking Location | true |
| `frequent-link-down` | `service-issue` | Frequent Link Down Issue | true |
| `ip-blacklisting` | `service-issue` | IP Blacklisting Issue | true |
| `non-service-area` | `service-issue` | Link in Non-Service Area / Jeopardy Location | true |
| `link-shifting-non-feasible` | `service-issue` | Link Shifting in Non-Feasible Location | true |
| `vendor-partner-support` | `service-issue` | Vendor / Partner Support Issue | true |

> **Source of truth:** `backend/src/modules/commercial-changes/disconnection-reasons.ts` in the SAM repo. If categories change, the SAM team will coordinate with CRM via this doc before deploying.

### Seed SQL (suggested shape — adapt to your column names)

```sql
INSERT INTO disconnection_categories (id, name, is_active) VALUES
  ('office-closed',    'Office Closed',     true),
  ('project-closed',   'Project Closed',    true),
  ('commercial-issue', 'Commercial Issue',  true),
  ('management-call',  'Management Call',   true),
  ('service-issue',    'Service Issue',     true)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_active = EXCLUDED.is_active;

INSERT INTO disconnection_sub_categories (id, category_id, name, is_active) VALUES
  ('office-closed',                       'office-closed',    'Office Closed', true),
  ('project-handovered-closed',           'project-closed',   'Project Handovered / Closed', true),
  ('moved-for-better-pricing',            'commercial-issue', 'Moved for Better Pricing', true),
  ('shifted-to-broadband',                'commercial-issue', 'Shifted to Broadband', true),
  ('company-in-crisis-business-downfall', 'commercial-issue', 'Company in Crisis / Business Downfall', true),
  ('shifted-to-telcom',                   'management-call',  'Shifted to Telcom (TTL / Airtel / Voda)', true),
  ('wants-single-isp',                    'management-call',  'Wants Single ISP', true),
  ('moved-to-coworking',                  'management-call',  'Moved to Coworking Location', true),
  ('frequent-link-down',                  'service-issue',    'Frequent Link Down Issue', true),
  ('ip-blacklisting',                     'service-issue',    'IP Blacklisting Issue', true),
  ('non-service-area',                    'service-issue',    'Link in Non-Service Area / Jeopardy Location', true),
  ('link-shifting-non-feasible',          'service-issue',    'Link Shifting in Non-Feasible Location', true),
  ('vendor-partner-support',              'service-issue',    'Vendor / Partner Support Issue', true)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_active = EXCLUDED.is_active;
```

### Validation rules CRM should enforce

- `disconnectionCategoryId` must exist in `disconnection_categories` and have `is_active = true`.
- `disconnectionSubCategoryId` must exist in `disconnection_sub_categories`, have `is_active = true`, **and** `category_id` must equal the supplied `disconnectionCategoryId`. SAM enforces the parent–child match client-side; CRM should double-check.

### Workflow stages — two-track approval (delivery + sales director)

**The current stages** the SAM team sees on returned service orders are:

```
PENDING_APPROVAL  (admin approval — single approval gate)
  → PENDING_DOCS_REVIEW
  → PENDING_NOC
  → PENDING_SAM_ACTIVATION
  → PENDING_ACCOUNTS
  → COMPLETED
```

**The new stages we want** depend on `orderType`. Sales Director approves every service order; Delivery Login also approves Upgrade/Downgrade (provisioning-impacting changes):

```
UPGRADE / DOWNGRADE
  DELIVERY_APPROVAL
    → SALES_DIRECTOR_APPROVAL
    → DOCS
    → NOC
    → ACCOUNTS
    → COMPLETED

RATE_REVISION / DISCONNECTION
  SALES_DIRECTOR_APPROVAL
    → DOCS
    → NOC
    → ACCOUNTS
    → COMPLETED
```

Rules:
- **`SALES_DIRECTOR_APPROVAL` is mandatory on every order type.** A service order cannot reach `DOCS` without it.
- **`DELIVERY_APPROVAL` is the entry stage for `UPGRADE` and `DOWNGRADE` only.** For rate revisions and disconnections, the order starts directly in `SALES_DIRECTOR_APPROVAL`.
- Either approver rejecting moves the order to a terminal `REJECTED` (or `DELIVERY_REJECTED` / `SALES_DIRECTOR_REJECTED` if you want the granularity — SAM will display either).
- The order moves forward only when the current approver approves; it can't skip a stage.

Changes the CRM team needs to make:

1. Replace the single `PENDING_APPROVAL` gate with **two new approval stages**:
   - `DELIVERY_APPROVAL` — actioned by users with a new **Delivery** role/permission.
   - `SALES_DIRECTOR_APPROVAL` — actioned by users with a **Sales Director** role/permission.
2. New approval routing on `POST /api/service-orders`:
   - `orderType IN ('UPGRADE', 'DOWNGRADE')` → initial `status = DELIVERY_APPROVAL`.
   - `orderType IN ('RATE_REVISION', 'DISCONNECTION')` → initial `status = SALES_DIRECTOR_APPROVAL`.
3. Wire two approval endpoints (or two actions on a single endpoint — your call):
   - When Delivery approves an Upgrade/Downgrade → move to `SALES_DIRECTOR_APPROVAL`.
   - When Sales Director approves → move to `DOCS`.
4. Rename `PENDING_DOCS_REVIEW` → **`DOCS`**.
5. Rename `PENDING_NOC` → **`NOC`**.
6. **Drop** the `PENDING_SAM_ACTIVATION` stage entirely. SAM no longer participates in setting an activation date on the order — the contractual notice period is enforced SAM-side via `scheduled_termination_at`, and account state is mirrored from `COMPLETED` only.
7. Rename `PENDING_ACCOUNTS` → **`ACCOUNTS`**.
8. Keep `COMPLETED`, `DOCS_REJECTED`, `REJECTED`, `CANCELLED` as terminal states (no change).
9. Return the new string values verbatim in the `status` field of:
   - `POST /api/service-orders` (creation response — must reflect the routed initial state per rule 2).
   - `GET /api/service-orders?customerId=…` (list).
   - `POST /api/service-orders/:id/set-activation-date` — **endpoint no longer used by SAM**; safe to deprecate.

SAM is already forward-compatible: the CRM-status pill maps the new state names (`DELIVERY_APPROVAL`, `SALES_DIRECTOR_APPROVAL`, `DOCS`, `NOC`, `ACCOUNTS`, `COMPLETED`) to amber-pending / emerald-completed / red-rejected pills. Legacy state names are kept in the mapping too, so any pre-rename data continues to render correctly.

### Confirming both dates are forwarded

SAM sends two date fields on every service-order POST:

| Field | Source | Format | Notes |
|---|---|---|---|
| `effectiveDate` | SAM form — when the change goes live | ISO 8601 datetime | Already supported on your side. |
| `mailReceivedDate` | SAM form — date SAM received the customer's approval email | ISO date (`YYYY-MM-DD`) | Added 2026-05-13. Sent on every order type (UPGRADE / DOWNGRADE / RATE_REVISION / DISCONNECTION). Please render it in the CRM order detail UI alongside Effective Date. |

If your `service_orders` table doesn't have a `mail_received_date` column yet, please add one:

```sql
ALTER TABLE service_orders
  ADD COLUMN IF NOT EXISTS mail_received_date DATE;
```

Then store the incoming `mailReceivedDate` value and surface it on whichever screen shows order details (alongside the existing Effective Date row).

### Existing CRM-side endpoint to keep working

SAM doesn't fetch from this endpoint anymore (the taxonomy is SAM-owned now), but if any other consumer relies on it, it should mirror the seeded data:

```
GET /api/service-orders/disconnection-reasons
→ {
    "data": [
      {
        "id": "office-closed",
        "name": "Office Closed",
        "isActive": true,
        "subCategories": [
          { "id": "office-closed", "name": "Office Closed", "isActive": true }
        ]
      },
      …
    ]
  }
```

---

## End-to-end flow after seeding

1. **SAM Day 0** — operator raises a disconnection. Customer moves to `PROBABLE_CHURN` on SAM. No CRM call yet.
2. **SAM Day 21** — operator clicks **Proceed** on `/probable-churn`.
3. **SAM → CRM** — `POST /api/service-orders` fires with the slug `disconnectionCategoryId` + `disconnectionSubCategoryId`. CRM validates against the seeded rows → returns the new order's `id`, `orderNumber`, `status`.
4. **SAM persists** `crmServiceOrderId`, `crmOrderNumber`, `crmStatus` on the change row.
5. **CRM team works the order** through the usual workflow (`PENDING_DOCS_REVIEW` → `PENDING_NOC` → `PENDING_SAM_ACTIVATION` → `PENDING_ACCOUNTS` → `COMPLETED`).
6. **SAM operator** can refresh CRM status from the Probable Churn page (calls `POST /commercial-changes/:id/refresh-status` which proxies to CRM's `GET /service-orders`).
7. **SAM Day 31** — SAM's lazy sweep terminates the account regardless of CRM status (the contractual 10-day notice is the source of truth). CRM should also move the order to `COMPLETED` around the same time, keeping both systems in sync.

---

## How to verify after seeding

From the SAM dev machine:

```bash
# Log in to CRM
TOKEN=$(curl -s -X POST http://localhost:5001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@ispcrm.com","password":"<password>"}' | jq -r .token)

# 1. Confirm categories are seeded
curl -s "http://localhost:5001/api/service-orders/disconnection-reasons" \
  -H "Authorization: Bearer $TOKEN" | jq

# 2. Dry-run a disconnection service-order
curl -i -X POST "http://localhost:5001/api/service-orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "customerId": "<a real CRM customer UUID>",
    "orderType": "DISCONNECTION",
    "disconnectionCategoryId":    "commercial-issue",
    "disconnectionSubCategoryId": "shifted-to-broadband",
    "disconnectionReason": "Dry run from SAM team",
    "notes": "SAM-TEST | Reason: Commercial Issue — Shifted to Broadband"
  }'
```

If step 2 returns `201 Created` with an order body, the bridge is healthy. Then on SAM, click **Proceed** on a probable-churn customer and the `CRM Hand-off` cell should show the order number + status pill instead of `CRM Call Failed`.

---

## Rollback / future changes

- If categories or sub-categories change, the SAM team updates `disconnection-reasons.ts` and re-issues this doc. Coordinate with CRM team before deploying — they need to add/deactivate rows first.
- Renaming `name` values is a no-op on the SAM side; only `id` matters for the bridge.
- `is_active = false` lets CRM retire an option without breaking history; SAM will still send the slug for legacy rows but new entries shouldn't pick it.
