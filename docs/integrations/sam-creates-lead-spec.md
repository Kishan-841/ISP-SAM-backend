# SAM → CRM — "Create Lead from SAM" Integration Spec

**Owner:** SAM platform engineering
**Audience:** CRM engineering (paste this into the CRM Claude session)
**Last updated:** 2026-05-21

A SAM operator picks a BDM (Team Leader or Solo BDM) from a dropdown, fills in a short lead form, and clicks **Create & Assign Lead**. The lead is created on the CRM side, immediately assigned to the chosen BDM, and shows up in that BDM's *New Leads Assigned* tab. The lead is permanently tagged as having originated from SAM, with the specific SAM operator who created it, so the BDM team can track SAM-sourced leads separately from their own pipeline.

---

## 1. The form (SAM-side UI)

Field list, in order, with types and validation. Required marked `*`.

| Field | Type | Required | Validation | Goes to CRM as |
|---|---|---|---|---|
| **Assign to BDM** | dropdown | ✅ | Must be one of the IDs returned by the BDM-list endpoint | `assignedTo.userId` |
| **Company Name** | text | ✅ | min 2 chars | `lead.companyName` |
| **Contact Name** | text | ✅ | min 2 chars | `lead.contactName` |
| **Phone** | text | ✅ | exactly 10 digits, India-mobile-format-ish (numeric, optional `+91`) | `lead.phone` |
| **Email** | text | optional | RFC email when present | `lead.email` |
| **Designation** | text | optional | free text, max ~100 chars | `lead.designation` |
| **Industry** | text | optional | free text, max ~100 chars | `lead.industry` |
| **City** | text | optional | free text, max ~100 chars | `lead.city` |
| **Notes** | textarea | optional | free text, max ~2000 chars | `lead.notes` |

Submit button: **"Create & Assign Lead"**. Disabled until all `*` fields are valid.

---

## 2. Endpoints CRM needs to build

Two synchronous JSON endpoints — *not* webhooks. The SAM operator is waiting on a confirmation toast, so async/retry semantics aren't appropriate here. If CRM rejects, SAM surfaces the rejection to the operator inline and they can fix the form.

### 2.1 `GET /api/integrations/sam/bdms`

Returns the list of users SAM can assign a lead to. Populates the dropdown at page load.

**Auth:** Bearer JWT — the same SAM-service-user JWT SAM already uses for `POST /service-orders` calls. Re-use the existing `CRM_SERVICE_EMAIL` / `CRM_SERVICE_PASSWORD` login flow on the SAM side.

**Request:** no body, no query params.

**Response — 200 OK:**

```json
{
  "bdms": [
    {
      "id": "<crm-user-uuid>",
      "name": "Rahul Mehta",
      "email": "rahul@gazonindia.com",
      "type": "TEAM_LEADER"
    },
    {
      "id": "<crm-user-uuid>",
      "name": "Kunal Patel",
      "email": "kunal@gazonindia.com",
      "type": "SOLO_BDM"
    }
  ]
}
```

Field semantics:

| Field | Type | Notes |
|---|---|---|
| `id` | UUID string | Stable — SAM stores this on the create-lead request |
| `name` | string | Display name in the dropdown |
| `email` | string | Shown as a sub-label so SAM operators can disambiguate two BDMs with the same first name |
| `type` | enum: `TEAM_LEADER` \| `SOLO_BDM` | SAM groups the dropdown by type — Team Leaders first, Solo BDMs below |

**Other response codes:**
- `401` — JWT expired / missing → SAM re-authenticates via the existing login flow and retries
- `5xx` — transient → SAM shows "Couldn't load BDM list, try again" and re-fetches on retry

**Caching:** SAM may cache the response per-page-load (refetch on form open, not on every keystroke). No long-lived caching — BDM team changes should reflect within a page reload.

### 2.2 `POST /api/integrations/sam/leads`

Creates a lead, assigns it to the chosen BDM, returns the CRM-side lead reference.

**Auth:** same JWT as above.

**Request body:**

```json
{
  "samLeadId": "<sam-side uuid, generated client-side per click>",
  "assignedTo": {
    "userId": "<crm-user-uuid from the bdms response>",
    "userType": "TEAM_LEADER"
  },
  "lead": {
    "companyName": "Acme Corp",
    "contactName": "John Doe",
    "phone": "9876543210",
    "email": "john@acme.com",
    "designation": "IT Manager",
    "industry": "IT Services",
    "city": "Mumbai",
    "notes": "Spoke at industry event. Looking for 100Mbps dedicated line."
  },
  "source": {
    "system": "SAM",
    "createdBy": {
      "id": "<sam-user-uuid>",
      "name": "Kishan Sapariya",
      "email": "kishan@gazonindia.com"
    },
    "createdAt": "2026-05-21T06:30:00.000Z"
  }
}
```

Field-by-field:

| Path | Type | Required | Notes |
|---|---|---|---|
| `samLeadId` | UUID | ✅ | SAM-side stable ID. CRM **must dedupe on this** — same `samLeadId` twice = idempotent `200 OK`, no second lead created. Prevents double-clicks creating duplicates. |
| `assignedTo.userId` | UUID | ✅ | Must match a user returned by `GET /bdms`. CRM 422s if it's not assignable. |
| `assignedTo.userType` | enum | optional | Echo of what SAM showed. CRM ignores for assignment logic but useful in CRM's audit. |
| `lead.companyName` | string | ✅ | |
| `lead.contactName` | string | ✅ | |
| `lead.phone` | string | ✅ | 10 digits, SAM strips spaces/dashes before sending |
| `lead.email` | string | optional | |
| `lead.designation` / `industry` / `city` / `notes` | string | optional | |
| `source.system` | literal `"SAM"` | ✅ | **Tracking tag** — CRM stores this on the Lead row so SAM-sourced leads are queryable separately from CRM's own lead pipeline |
| `source.createdBy.{id,name,email}` | strings | ✅ | The SAM operator who created the lead. CRM shows this in the lead detail view + audit log |
| `source.createdAt` | ISO 8601 | ✅ | SAM-side click time |

**Response — 201 Created:**

```json
{
  "lead": {
    "id": "<crm-lead-uuid>",
    "leadNumber": "GAZ-0042",
    "assignedToUserId": "<crm-user-uuid>",
    "assignedToName": "Rahul Mehta",
    "createdAt": "2026-05-21T06:30:01.421Z"
  },
  "samLeadId": "<echo of what SAM sent>"
}
```

SAM stores both `id` (UUID) and `leadNumber` (GAZ-style display ref) on its own audit row.

**Response — 200 OK (idempotent replay):**

```json
{
  "lead": { ...same shape as 201... },
  "samLeadId": "<echo>",
  "deduped": true
}
```

**Error responses:**

| Code | Meaning | SAM behaviour |
|---|---|---|
| `400` | Body malformed | Show the specific validation error in the form (inline + toast) |
| `401` | JWT expired | Re-login, retry once |
| `404` | `assignedTo.userId` doesn't match any BDM | Show "Selected BDM no longer exists — please pick again" + reload the BDM dropdown |
| `409` | Conflict — same `samLeadId` already exists under a *different* payload | Surface as "This lead has already been submitted but with different details. Refresh and try again." |
| `422` | Business-rule failure (e.g. BDM is inactive, phone conflicts with another lead) | Surface the message verbatim |
| `5xx` | Transient | Show "Couldn't reach CRM, try again" — SAM does NOT auto-retry (user is waiting; let them retry) |

---

## 3. What CRM stores on the Lead row

For every SAM-created lead, persist these new columns on the existing CRM `Lead` model:

| Column | Type | Source |
|---|---|---|
| `source` | enum: `'SAM'` \| `'DIRECT'` \| `'OTHER'` | from `source.system` |
| `samCreatedById` | string | from `source.createdBy.id` |
| `samCreatedByName` | string | from `source.createdBy.name` |
| `samCreatedByEmail` | string | from `source.createdBy.email` |
| `samCreatedAt` | timestamptz | from `source.createdAt` |
| `samLeadId` | UUID, UNIQUE | from `samLeadId` — used for dedupe |

The unique constraint on `samLeadId` is what makes the endpoint idempotent.

### Lead detail view

In CRM's existing Lead detail page, when `source='SAM'`, surface:
- A small badge: **"SAM" (orange)** next to the lead name
- A "Sourced by" line: `<samCreatedByName> · <samCreatedByEmail> · <samCreatedAt>`
- The notes field (which carries SAM's `lead.notes`) prefixed with `Source: SAM`

### Filterable list

The BDM's "New Leads Assigned" tab should let the BDM filter by source — e.g. a `?source=SAM` query param + a checkbox in the UI. Even simpler: just show the SAM badge inline so they can tell at a glance.

---

## 4. SAM-side changes (what we'll build)

This is for our own records — the CRM team only cares about §1–3.

### Backend

- New endpoint `GET /integrations/crm/bdms` — proxies through to CRM's `/api/integrations/sam/bdms`, authenticated via the existing CRM service-user JWT. Cached in-memory for the duration of the request (no need to refetch).
- New endpoint `POST /leads` — receives the form payload, validates with Zod, calls CRM's `/api/integrations/sam/leads`, audit-logs the outcome, returns `{ leadNumber, assignedToName, status }` to the SAM frontend.
- New table `sam_lead_dispatches` (or audit_log entries — pick whichever is more queryable). Captures:
  - `samLeadId` (UUID)
  - `assignedToUserId`, `assignedToName`
  - `companyName`, `contactName`, `phone`, `email`, `designation`, `industry`, `city`, `notes`
  - `createdBySamUserId`, `createdAt`
  - `crmLeadId`, `crmLeadNumber` (populated on success)
  - `status` — `SENT` | `FAILED`
  - `errorReason` — when FAILED
- Add `CRM_BDM_LIST_URL` env var (optional override; defaults to `${CRM_API_BASE_URL}/integrations/sam/bdms`).
- Add `CRM_LEAD_CREATE_URL` env var (same pattern).

### Frontend

- New page `/create-lead` (sidebar entry: "Create Lead").
- Form matching the screenshot exactly — same field order, same labels, same placeholders.
- On page load: `GET /integrations/crm/bdms` populates the dropdown (skeleton state while loading).
- On submit: `POST /leads` → toast on success with the new lead number, redirect to a "history" page or back to the form pre-cleared.
- Toast on failure with friendly translation (same `friendlyEmailError` pattern as the MoM dialog) — common cases:
  - `BDM no longer exists` → "Pick another BDM and try again."
  - `phone already exists` → "This phone number is already on a CRM lead."
  - `Couldn't reach CRM` → "Try again in a minute."
- New section on the SAM home / "Recent activity" page: **"Leads I created"** — last N leads with their CRM lead number + assigned BDM name + status. Lets the SAM operator confirm their leads landed.

### Audit

- Every dispatch (success or failure) writes an `audit_log` row: `action=SAM_LEAD_DISPATCHED`, payload includes the full form data + the CRM response.

---

## 5. The "SAM lead" tracking tag

Per your specific ask: every lead created via this flow carries two distinct markers so CRM can prove it came from SAM and trace it back:

1. **`source.system = "SAM"`** — at the lead level (CRM persists as `Lead.source = 'SAM'`). This is the **what** — "this lead was created from outside CRM via the SAM integration."

2. **`source.createdBy = { id, name, email }`** — at the user level (CRM persists three columns). This is the **who** — "specifically, the SAM operator with this id sent it on this date."

Together they answer "which leads came from SAM, and from whom?" with a single SQL query on CRM side:
```sql
SELECT id, leadNumber, samCreatedByName, samCreatedAt
FROM leads
WHERE source = 'SAM'
ORDER BY samCreatedAt DESC;
```

### Visual identification in CRM UI

- **In list views:** small orange "SAM" pill next to the lead name (matches SAM's brand orange `#ea580c`).
- **In detail view:** a "Created from SAM" callout box showing the SAM operator's name, email, and original create timestamp.
- **In CRM's audit log for the Lead:** the first audit entry should be `CREATE` with `userId=null`, `userName="<samCreatedByName>"`, `note="Created from SAM by <email>"`.

---

## 6. Edge cases

| Scenario | Behaviour |
|---|---|
| BDM is deactivated between SAM page-load and submit | CRM returns `404` (assignedTo userId not assignable). SAM shows "BDM no longer available" + reloads dropdown. |
| Same phone number already exists on a CRM lead | CRM decides — either accept (allow multiple leads per phone) or reject `422`. SAM displays the message either way. |
| SAM operator double-clicks Submit | Both requests carry the same `samLeadId` (generated once per form mount). CRM's UNIQUE constraint dedupes. Second click returns `200 deduped: true`. SAM toast says "Already submitted." |
| BDM list endpoint is down at page load | SAM shows "Couldn't load BDM list. Retry?" inside the form. No leads can be created until it succeeds. |
| Lead created but BDM never acts on it | Out of scope for this PR — that's BDM-side workflow. SAM doesn't track post-creation lead state today (we don't get notified on qualification / loss). Optional follow-up: CRM fires a webhook back to SAM when the lead transitions, similar to the `commercialChange.statusChanged` pattern. |

---

## 7. Auth recap

| Direction | Mechanism | Secret |
|---|---|---|
| SAM → CRM `GET /bdms` | Bearer JWT | `CRM_SERVICE_EMAIL` + `CRM_SERVICE_PASSWORD` (existing — SAM logs in once, caches JWT 50min) |
| SAM → CRM `POST /leads` | Bearer JWT | Same |

No HMAC webhook signing on this flow — these are synchronous API calls, not async events. The existing JWT setup already handles them.

---

## 8. CRM-team checklist

- [ ] New columns on `Lead` model: `source`, `samCreatedById`, `samCreatedByName`, `samCreatedByEmail`, `samCreatedAt`, `samLeadId` (UNIQUE)
- [ ] Migration for the above
- [ ] `GET /api/integrations/sam/bdms` — returns active BDM Team Leaders + Solo BDMs
- [ ] `POST /api/integrations/sam/leads` — validates + creates + assigns + dedupes
- [ ] Both endpoints behind the existing SAM-service-user JWT auth (no new auth scheme)
- [ ] Lead detail UI: SAM badge + "Created from SAM by …" callout when `source='SAM'`
- [ ] BDM "New Leads Assigned" tab: SAM badge visible inline; optional `?source=SAM` filter
- [ ] Confirm dedupe semantics: same `samLeadId` twice → 200 `{ deduped: true }` with the original lead's ID, no new row
- [ ] Provide test creds / a dev BDM user for SAM to test against

---

## 9. SAM-team checklist (mine)

- [ ] Add `CRM_BDM_LIST_URL` + `CRM_LEAD_CREATE_URL` env vars (with defaults derived from `CRM_API_BASE_URL`)
- [ ] Backend: `GET /integrations/crm/bdms` proxy endpoint
- [ ] Backend: `POST /leads` endpoint with full validation
- [ ] Backend: audit-log every dispatch
- [ ] Migration: `sam_lead_dispatches` table (or repurpose audit_log)
- [ ] Frontend: `/create-lead` page matching the screenshot
- [ ] Frontend: sidebar link
- [ ] Frontend: toast translations for common failure modes
- [ ] Frontend: "Leads I created" history widget (Phase 2 — optional)

I'll start the SAM-side scaffolding behind a feature flag once CRM confirms §8 is being built. Until both sides are ready, SAM will gate the `/create-lead` route behind `LEAD_DISPATCH_ENABLED=true`.

---

## 10. Open questions for CRM team

These need decisions before SAM starts building:

1. **BDM type names** — do you actually call them `TEAM_LEADER` and `SOLO_BDM`, or do you use different role strings (`bdm_tl`, `bdm`, etc.)? Whatever you use is fine — just confirm.
2. **Lead `source` enum values** — what other source values exist today? (`'DIRECT'`, `'MARKETING'`, `'REFERRAL'`?) Need to know the full enum so SAM-sent leads slot in cleanly.
3. **Phone uniqueness** — does CRM enforce phone-number uniqueness on Leads? If yes, what should SAM do when the same phone is re-submitted (422 / dedupe / create-anyway)?
4. **BDM availability** — should the BDM dropdown include BDMs who are on leave / inactive? Or only those currently accepting new leads? If the latter, the BDM model needs an `acceptingNewLeads` flag.
5. **Notification to BDM** — when a SAM lead is assigned, does CRM auto-notify the BDM (email/in-app)? If yes, what does that look like — should the notification mention it came from SAM?

---

Once §8 is done and §10 is answered, ping me and I'll cut the SAM-side PR.
