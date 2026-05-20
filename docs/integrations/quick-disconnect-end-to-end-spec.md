# Quick Disconnect — End-to-End Workflow Spec

**Owner:** SAM platform engineering
**Audience:** CRM engineering (their Claude session can read this directly)
**Status:** Source-of-truth for the desired flow. Replaces the "approval-only gate" model the CRM side currently has.
**Last updated:** 2026-05-20

This doc supersedes the original `sam-quick-disconnect-contract.md` on a single point: **CRM admin approval is not a terminal state — it is the first stage of the normal service-order workflow on a tighter clock.**

---

## 1. The desired flow (5 stages)

```
   SAM raises QUICK             CRM admin                   CRM ops              CRM NOC                CRM accounts            Customer
   (with reason + days)         clicks Approve              reviews docs         disconnects            closes billing          terminated
        │                             │                          │                    │                       │                      │
        ▼                             ▼                          ▼                    ▼                       ▼                      ▼
  ┌──────────────────┐         ┌─────────────────┐       ┌─────────────────┐  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
  │ PENDING_ADMIN_   │   →     │ PENDING_DOCS_   │  →    │ PENDING_NOC     │→ │ PENDING_        │ →  │ COMPLETED       │ →  │ TERMINATED      │
  │ APPROVAL         │         │ REVIEW          │       │                 │  │ ACCOUNTS        │    │ (CRM)           │    │ (SAM account    │
  │                  │         │                 │       │                 │  │                 │    │                 │    │ contract status)│
  └──────────────────┘         └─────────────────┘       └─────────────────┘  └─────────────────┘    └─────────────────┘    └─────────────────┘
   SAM raises, waits             admin approved,           docs cleared,         NOC done,              billing closed,         service order done,
   on CRM admin                  workflow ticket           ready for NOC         ready for accounts     ready for COMPLETED     SAM account hard
                                 created on CRM                                                                                 terminated
```

Every transition fires an outbound webhook from CRM → SAM so the SAM UI reflects the live status without the operator having to poll.

The original "rejected on QUICK request" path stays — if CRM admin rejects the QUICK request at the first stage, the account reverts to ACTIVE on SAM and the workflow never starts. Rejections at later stages (e.g. docs review fails) end the workflow at REJECTED and SAM is notified.

---

## 2. Status names (canonical)

These are the status strings that travel on every webhook payload and persist on `commercial_changes.crm_status` on SAM. Both sides must agree on the exact strings.

| Stage | Status string | Who advances | What it means |
|---|---|---|---|
| 1 | `PENDING_ADMIN_APPROVAL` | CRM admin clicking Approve / Reject in the Approvals → Quick Disconnects inbox | SAM raised a QUICK request. Account on SAM: `PENDING_QUICK_APPROVAL`. No service order exists on CRM yet — just the inbox row. |
| 2 | `PENDING_DOCS_REVIEW` | CRM ops team in the service-order workflow | Admin approved → CRM auto-creates a service-order row and starts the standard workflow at docs review. Account on SAM: `DISCONNECTING`. |
| 3 | `PENDING_NOC` | CRM NOC team | Docs cleared. NOC handles the physical/network disconnection. |
| 4 | `PENDING_ACCOUNTS` | CRM accounts team | NOC done. Accounts closes billing, generates final invoice. |
| 5 | `COMPLETED` | CRM accounts marking it complete | Service order done. Triggers the final SAM-side termination via `customer.disconnected` webhook (see §5). |

Terminal failure states (any stage can end here):

| Status string | Triggered by | What SAM does on receive |
|---|---|---|
| `REJECTED` | Admin rejects the QUICK request (stage 1) | Account → ACTIVE, decision note stored, workflow never started. |
| `DOCS_REJECTED` | Docs review fails (stage 2) | Account → ACTIVE *or* stays DISCONNECTING (operator decision — see §4). |
| `NOC_REJECTED` | NOC step fails (stage 3) | Same as above. |
| `CANCELLED` | CRM admin cancels mid-workflow | Account → ACTIVE, workflow abandoned. |

---

## 3. Wire-level contract — each transition

All webhooks use the **same signing scheme** as `customer.activated`: HMAC-SHA256 over `${X-CRM-Timestamp}.${rawBody}`, headers `X-CRM-Signature` + `X-CRM-Timestamp`, shared secret `SAM_WEBHOOK_SECRET` (CRM side) = `CRM_WEBHOOK_SECRET` (SAM side). ±5 min skew window. Dedupe on `eventId`.

### 3.1 SAM → CRM: `quickDisconnect.requested` (stage 1 entry — already exists)

```
POST <crm-host>/webhooks/sam/quick-disconnect.requested
```

Payload as per existing contract `sam-quick-disconnect-contract.md §1`. **No changes needed on CRM side for this direction.**

### 3.2 CRM → SAM: `commercialChange.statusChanged` (NEW — fires on EVERY transition)

This is the key change. Instead of one webhook only on the admin's first decision, CRM fires this on every status transition (2→3, 3→4, 4→5, and into terminal failure states).

```
POST https://sam-api.gazonindia.com/integrations/crm/commercial-change-status
POST https://sam-api.gazonindia.com/webhooks/crm/commercial-change.status-changed   (alias — pick either URL)
```

#### Headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-CRM-Signature` | HMAC-SHA256 hex (same scheme as existing webhooks) |
| `X-CRM-Timestamp` | Unix seconds |

#### Body

```json
{
  "eventId": "<fresh UUID per transition>",
  "eventType": "commercialChange.statusChanged",
  "occurredAt": "2026-05-20T11:55:00.000Z",
  "commercialChangeId": "<the same SAM UUID we've been carrying>",
  "fromStatus": "PENDING_DOCS_REVIEW",
  "toStatus": "PENDING_NOC",
  "changedBy": "kishan.docs@gazonindia.com",
  "note": "Approval doc verified — handing to NOC.",
  "serviceOrderId": "<CRM service-order id>",
  "serviceOrderNumber": "SO-2026-0042"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `eventId` | UUID | ✅ | Fresh per transition. Reused across retries. SAM dedupes. |
| `eventType` | `"commercialChange.statusChanged"` | ✅ | |
| `occurredAt` | ISO-8601 | ✅ | When the transition happened on CRM side. |
| `commercialChangeId` | UUID | ✅ | Echo of the SAM-side commercial-change id we sent in `quickDisconnect.requested`. |
| `fromStatus` | enum | optional | Previous status. Helps SAM detect out-of-order delivery. |
| `toStatus` | enum | ✅ | The new status. Must be one of the strings in §2. |
| `changedBy` | string | ✅ | CRM-side user email/id who triggered the transition. |
| `note` | string | optional on success transitions, **required** on `*_REJECTED` / `CANCELLED` | Surfaces back to the SAM operator. |
| `serviceOrderId` | string | ✅ (once the service order exists, i.e. from stage 2 onwards) | CRM's service-order primary key. |
| `serviceOrderNumber` | string | ✅ (once the service order exists) | Human-readable reference (e.g. `SO-2026-0042`). |

#### Response SAM returns

| Code | Meaning | CRM should |
|---|---|---|
| `200`/`201` | Processed (or idempotent dedup with `{ deduped: true }`) | Mark DELIVERED |
| `400` | Bad payload / unknown `toStatus` enum | Mark FAILED, no retry — fix the payload |
| `404` | Unknown `commercialChangeId` | Mark FAILED, no retry — investigate |
| `409` | Out-of-order delivery (`toStatus` doesn't make sense given current SAM state) | Mark FAILED, manual replay if needed |
| `5xx` | Transient | Retry with backoff (same schedule as `quickDisconnect.decided`) |

### 3.3 SAM → CRM: `customer.disconnected` (NEW — fires when SAM hard-terminates)

When SAM's `sweepDueTerminations()` actually terminates the account (sets `contract_status='TERMINATED'`), SAM fires this back to CRM so the Lead's `actualPlanIsActive` flag flips false. Symmetric with the existing `customer.activated` direction.

```
POST <crm-host>/webhooks/sam/customer.disconnected
```

#### Body

```json
{
  "eventId": "<uuid>",
  "eventType": "customer.disconnected",
  "occurredAt": "2026-06-04T00:00:00.000Z",
  "customer": { "externalId": "<CRM lead UUID>" },
  "commercialChangeId": "<uuid>",
  "terminationDate": "2026-06-04",
  "finalArc": 80000
}
```

CRM-side action: flip `Lead.actualPlanIsActive=false`, set `actualPlanEndDate=terminationDate`, audit. CRM Team already agreed to build this — ~30 lines mirroring the existing `samWebhookInbound` controller.

### 3.4 Replace `quickDisconnect.decided` with `commercialChange.statusChanged`

The existing `quickDisconnect.decided` webhook becomes a *special case* of `commercialChange.statusChanged` with `toStatus=PENDING_DOCS_REVIEW` (on approve) or `toStatus=REJECTED` (on reject). CRM can either:

- **Option A (preferred):** retire `quickDisconnect.decided` entirely and fire `commercialChange.statusChanged` instead.
- **Option B:** keep both (fire `quickDisconnect.decided` *and* `commercialChange.statusChanged` on first decision) — wasteful but backward compatible.

Either way, SAM's existing handler at `/integrations/crm/quick-disconnect-decision` continues to work as a fallback so the migration can be staged.

---

## 4. Edge cases and policy questions for CRM to confirm

### 4.1 What happens if `DOCS_REJECTED` lands at stage 2?

Two reasonable behaviours — CRM team to decide and stick with one:

| Policy | What it does |
|---|---|
| **Hard revert** | Account flips back to ACTIVE on SAM. Customer is NOT disconnected. SAM operator gets a notification + the rejection note. They can fix paperwork and resubmit. |
| **Operator escalation** | Account stays DISCONNECTING. SAM operator must explicitly retain (via rate-revision auto-retain) or escalate to admin. Closer to the existing PROCEED rejection-mid-workflow behaviour. |

SAM is fine with either — pick one. Recommend **Hard revert** for symmetry with the stage-1 REJECT and to keep the model simple.

### 4.2 What does CRM admin see for a QUICK request post-approval?

The Approvals → Quick Disconnects → Approved tab is a *history* view. Once an admin approves, the request enters the standard service-order workflow visible elsewhere in CRM. The Approved tab continues to show the original approval action (audit trail), but the live workflow stage is on the service-order detail page.

### 4.3 Is the `PENDING_SAM_ACTIVATION` step part of the QUICK workflow?

**No.** That step exists in the upgrade/downgrade workflow to collect a billing-start date from the customer. Disconnections don't need a billing-start date — the customer is going away. So:

- Normal disconnection workflow (already exists): `PENDING_DOCS_REVIEW → PENDING_NOC → PENDING_ACCOUNTS → COMPLETED` (CRM should confirm this matches their current normal-disconnect implementation).
- QUICK disconnection: same 4-stage workflow gated by `PENDING_ADMIN_APPROVAL` at the front.

If CRM's current normal-disconnect workflow includes `PENDING_SAM_ACTIVATION`, that's a bug to fix on their side — disconnections shouldn't ask SAM for an activation date.

### 4.4 Who creates the service order — SAM or CRM?

Currently SAM calls `POST /service-orders` after receiving the `quickDisconnect.decided` webhook. **Going forward (cleaner):** CRM auto-creates the service order at the moment the admin approves, then fires `commercialChange.statusChanged { toStatus: 'PENDING_DOCS_REVIEW', serviceOrderId, serviceOrderNumber }` to SAM. SAM stops calling `/service-orders` for QUICK approvals.

This way the order creation and the status webhook are atomic on CRM side, eliminating the race where the webhook might land before the service order exists.

If CRM team prefers SAM stays as the order-creator, that's fine too — just ensure the existing `/service-orders` endpoint accepts an order for a Lead that's just been QUICK-approved (i.e. no "already decided" rejection).

---

## 5. SAM-side guarantees (what we promise)

For each `commercialChange.statusChanged` webhook SAM receives:

1. **Idempotent**: same `eventId` twice = `200` deduped, no state change.
2. **Persisted**: `commercial_changes.crm_status` updated, `crm_status_updated_at` stamped.
3. **Audit log**: a row written with `action=CRM_STATUS_CHANGED`, payload echoing `fromStatus / toStatus / changedBy / note`.
4. **UI live**: the `/transactions` row's CRM Status pill reflects the new status on next page load (or immediately if the user is on the row-detail sheet).
5. **Termination on COMPLETED**: when `toStatus=COMPLETED` arrives, SAM marks the account TERMINATED, fires `customer.disconnected` back to CRM, and the disconnection is done.
6. **Termination on day N (regardless of CRM stage)**: SAM's hard-termination timer fires on `today + quickRequestedDays` even if CRM hasn't reached COMPLETED yet. This is intentional — speed is the whole point of QUICK. If CRM lags, the customer terminates anyway and the operator chases the CRM-side service order separately.

---

## 6. Migration / rollout plan

1. **CRM** implements:
   - Auto-create service order on QUICK admin approval (§4.4).
   - Fire `commercialChange.statusChanged` on every transition (§3.2).
   - Inbound `customer.disconnected` receiver (§3.3).
2. **SAM** implements:
   - Inbound `commercialChange.statusChanged` handler (new endpoint + service method).
   - Outbound `customer.disconnected` from `sweepDueTerminations`.
   - Remove the SAM-side call to `/service-orders` after QUICK approval (CRM does it now).
   - UI: relabel "Quick · Awaiting CRM" to "Pending Admin Approval" + show the workflow progression on the row-detail sheet.
3. **Coordinated cutover** — both sides agree on a deploy window. Until then, both old (`quickDisconnect.decided`) and new (`commercialChange.statusChanged`) handlers coexist.

---

## 7. Open items for CRM team to confirm

- [ ] CRM agrees with the 5-stage flow + status enum names in §2.
- [ ] CRM normal-disconnect workflow doesn't include `PENDING_SAM_ACTIVATION` (or commits to removing it for disconnections).
- [ ] CRM commits to firing `commercialChange.statusChanged` on every transition.
- [ ] CRM commits to auto-creating the service order on QUICK approval (§4.4 option preferred).
- [ ] CRM commits to building the `customer.disconnected` inbound receiver (§3.3).
- [ ] CRM picks a rejection policy for stages 2–3 (§4.1) — recommend Hard revert.

When all checkboxes are answered, SAM team starts the inbound handler + outbound `customer.disconnected` work.
