# SAM ↔ CRM Quick Disconnect — Answers to CRM team's questions

**Date:** 2026-05-20
**Audience:** CRM engineering (paste this into your Claude session)
**Reply to:** the question list under "Questions for SAM team"

---

## A. Payload shapes

### A1. Full JSON body of `quickDisconnect.requested` (SAM → CRM)

This is the **exact** payload SAM sends today, taken straight from `crm-quick-disconnect-client.ts`:

```json
{
  "eventId": "<fresh UUID per request>",
  "eventType": "quickDisconnect.requested",
  "occurredAt": "2026-05-20T13:37:22.817Z",
  "commercialChangeId": "ee0e7a5b-05b2-438e-b537-e0d555f81727",
  "customer": {
    "externalId": "d8177a9d-838f-401a-808e-eb832f994de3"
  },
  "raisedBy": {
    "id": "d7792fe5-4e36-49d0-a62e-d65b7cefe90b",
    "email": "kishan@gazonindia.com"
  },
  "reason": "testing this",
  "disconnectionCategoryId": "office-closed",
  "disconnectionSubCategoryId": "office-closed",
  "requested": {
    "arc": 80000,
    "planName": null,
    "bandwidth": null,
    "days": 1
  }
}
```

To your specific sub-questions:

| Field you asked about | Does SAM send it? | Notes |
|---|---|---|
| `customerNoticeDate` / `noticeDate` / `noticeReceivedAt` | ❌ Not currently sent | SAM has this on its row (column `effective_date`, the form labels it "Customer notice date"). Easy to add to the payload if CRM wants it for display. |
| `terminationAfterApprovalDays` / `terminationDays` / `quickRequestedDays` | ✅ Sent as `requested.days` | Integer, 1..15 |
| `effectiveDate` (directly) | ❌ Not currently sent | Same as customerNoticeDate above — easy to add |
| `disconnectionCategoryId` / `disconnectionSubCategoryId` | ✅ Sent at top level | Added after CRM's last 400 about missing fields |
| `mailReceivedDate` | ❌ Not currently sent | On the row. Available to add |
| `arc` / `planName` / `bandwidth` | ✅ Sent under `requested` | All optional |

**Fields documented in the contract but not yet sent:** none (we send a superset of §1 now).

**Fields sent but not documented in the contract:** `disconnectionCategoryId`, `disconnectionSubCategoryId`, `requested.days`. These were added after CRM raised validation errors; the contract doc on your side needs updating to match.

### A2. Full JSON body of `POST /service-orders` (SAM → CRM)

From `buildServiceOrderInput()` in `commercial-changes.service.ts:996`. For a **DISCONNECTION** order:

```json
{
  "customerId": "<CRM lead UUID — accounts.externalCrmId>",
  "orderType": "DISCONNECTION",
  "approvalFileUrl": "<Cloudinary HTTPS URL — only if file attached>",
  "poFileUrl": "<Cloudinary HTTPS URL — only if file attached>",
  "mailReceivedDate": "2026-05-20",
  "notes": "SAM-EE0E7A5B | <optional caller notes>",
  "disconnectionCategoryId": "office-closed",
  "disconnectionSubCategoryId": "office-closed",
  "disconnectionReason": "<optional free text from SAM operator>"
}
```

For an **UPGRADE / DOWNGRADE / RATE_REVISION** order (different shape — relevant to your screenshot confusion, see E1):

```json
{
  "customerId": "<CRM lead UUID>",
  "orderType": "DOWNGRADE",
  "newArc": 80000,
  "newBandwidth": 80,
  "effectiveDate": "2026-05-16T00:00:00.000Z",
  "approvalFileUrl": "...",
  "poFileUrl": "...",
  "mailReceivedDate": "2026-05-16",
  "notes": "SAM-D2E3E7CF"
}
```

To your specific sub-questions:

| Question | Answer |
|---|---|
| `orderType` value for QUICK-originated disconnections | Same as normal disconnections — `"DISCONNECTION"`. SAM does NOT differentiate quick vs normal at the service-order layer (see §B1). |
| `effectiveDate` — sent directly, or computed by CRM? | **Not sent for DISCONNECTION** orders. Only included for UPGRADE / DOWNGRADE / RATE_REVISION. For disconnections, CRM should compute the termination date from `commercialChange.statusChanged → toStatus=PENDING_DOCS_REVIEW.occurredAt + quickRequestedDays` (for QUICK) or use the standard 21+10 day windows (for NORMAL). See §C3. |
| `mailReceivedDate` | The date the SAM operator received the customer's approval email — collected via the form's "Mail Received Date" field. ISO date string (no time). |
| Any retention / final-billing fields | ❌ None sent in `/service-orders`. The retention window is tracked entirely SAM-side. SAM expects CRM to handle billing closeout autonomously after termination. |

---

## B. Per spec §4.4 cutover

### B1. Is SAM still calling `POST /service-orders` after a QUICK admin approval?

**Conditional yes — depends on which event CRM fires.**

| If CRM fires... | SAM does... | Service order created by... |
|---|---|---|
| `commercialChange.statusChanged` (new event, §3.2) | Stamps `crm_status`, account → DISCONNECTING. **Does NOT call /service-orders.** | CRM-side auto-creation on admin approval (per spec §4.4) |
| `quickDisconnect.decided` (legacy event, §3.4) | Stamps decision metadata, account → DISCONNECTING, **AND calls /service-orders** | SAM-side call (legacy behavior) |

Verified by the audit log on SAM-side dev DB: today CRM is firing **only** `commercialChange.statusChanged` — so in practice, no SAM-side `/service-orders` call happens for QUICK approvals. The legacy code path is dormant.

### B2. Duplicate-order risk

**Today: no duplicates** as long as CRM keeps firing only the new event. If CRM ever falls back to firing both (during a migration window or by accident), SAM would create a duplicate.

**SAM is removing the legacy `/service-orders` call** in the same deploy as the dispatcher endpoint (commit incoming after this doc — see the final section). That removes the duplicate risk entirely; the legacy event handler will continue to stamp decision metadata but won't raise a CRM order.

---

## C. Semantics

### C1. What does "Customer notice date" mean?

**(a) — the date the customer notified SAM they want to disconnect.**

It's the date the SAM operator types into the form when raising the request, and it's the day-zero anchor for the standard 21-day retention window. SAM does NOT use it to notify the customer of anything — billing/comms is CRM's job downstream.

(b) is not a SAM concept — SAM never sends notifications outward to customers.

### C2. "Termination after approval" — unit + typical value

| Aspect | Value |
|---|---|
| Unit | **Calendar days** (UTC, start-of-day) |
| Range | 1–15 inclusive (enforced both at the form layer and via a `CHECK` constraint on `commercial_changes.quick_requested_days`) |
| Typical QUICK value | Operator's choice. 1 day for "customer already shut down ops", 7 days for "fraud verified", up to 15 for "give them a runway". |
| Standard non-QUICK window | 21 days retention + 10 days notice = ~31 days total |

### C3. Effective-date formula

**For QUICK:** `effectiveDate = adminApprovedAt + quickRequestedDays` (option **(a)** from your list).

The exact source of `adminApprovedAt` on SAM side is `commercialChange.statusChanged.occurredAt` when `toStatus=PENDING_DOCS_REVIEW`. SAM uses **its own** `new Date()` at webhook-receive time as a defensive fallback (in case the timestamps skew) — but the canonical source is CRM's `occurredAt`.

CRM should compute its termination date the same way to avoid drift.

| Your option | SAM's choice | Why |
|---|---|---|
| (a) `effectiveDate = adminApprovedAt + terminationAfterApprovalDays` | ✅ This one for QUICK | Speed-from-approval is the whole point of QUICK |
| (b) `effectiveDate = customerNoticeDate + terminationAfterApprovalDays` | ❌ Wrong for QUICK | Customer notice date may be days/weeks before admin approval |
| (c) `effectiveDate = quickRequestedAt + terminationAfterApprovalDays` | ❌ Wrong | Timer starts when admin says yes, not when SAM raises |
| (d) SAM passes the date precomputed | ❌ Not today | SAM doesn't include effectiveDate in the QUICK payload. Could be added if CRM wants the canonical value sent over the wire — see Open Items below. |

### C4. NORMAL vs QUICK effective-date

**Different.** SAM-side anchors:

```
NORMAL:                     QUICK:
day 0  customer notice      day 0  customer notice (instant fwd to CRM admin)
                                   ↓
day 0–21  retention window  day N  admin approves (N = however long admin takes)
day 21 SAM PROCEED                 ↓
                            day N + quickRequestedDays  termination
day 21 → day 31 (10 day notice)
day 31  termination
```

For NORMAL, SAM `POST /service-orders` carries `notes` and the order's effective date is implicitly `day 21 + 10`. CRM controls the workflow timing from there.

For QUICK, CRM auto-creates the service order on admin approval and `termination = approval + quickRequestedDays`. SAM still hard-terminates locally on that day regardless of CRM's workflow position.

---

## D. Field deltas

### D1. SAM-sent fields not in the contract

| Field | Direction | Contract doc | Why it's sent |
|---|---|---|---|
| `quickDisconnect.requested.disconnectionCategoryId` | SAM → CRM | Missing (you required it, we added it) | CRM's validator required it |
| `quickDisconnect.requested.disconnectionSubCategoryId` | SAM → CRM | Missing | Same |
| `quickDisconnect.requested.requested.days` | SAM → CRM | Missing | Tells admin the SLA SAM is asking for |
| `POST /service-orders.notes` (with `SAM-XXXXXXXX` prefix) | SAM → CRM | Documented | Cross-system support reference |
| `POST /service-orders.mailReceivedDate` | SAM → CRM | Documented in normal-disconnect flow, not in QUICK | Carried through QUICK too |

**Recommendation:** update the original `sam-quick-disconnect-contract.md` to list `disconnectionCategoryId`, `disconnectionSubCategoryId`, and `requested.days` as required. The newer spec `quick-disconnect-end-to-end-spec.md` references the older doc — keeping both in sync prevents the next round-trip failure.

### D2. Fields CRM sends that SAM expects but might be missing

SAM's Zod schema for `commercialChange.statusChanged` requires:

```
eventId         (uuid)      ✅ required
eventType       (literal)   ✅ required, must be "commercialChange.statusChanged"
occurredAt      (ISO date)  ✅ required
commercialChangeId (uuid)   ✅ required — must match what SAM sent in quickDisconnect.requested
toStatus        (string)    ✅ required — free-text, see allowed values in spec §2
changedBy       (string)    ✅ required — admin email or user id
fromStatus      (string)    optional — helps SAM detect out-of-order delivery
note            (string)    optional on success, REQUIRED on REJECTED/DOCS_REJECTED/NOC_REJECTED/CANCELLED per spec §4.1
serviceOrderId  (string)    SHOULD be present from stage 2 onwards (PENDING_DOCS_REVIEW and later) so SAM can persist it
serviceOrderNumber (string) Same as above
```

If CRM is firing without `serviceOrderId` / `serviceOrderNumber` once the service order exists, SAM persists null and the operator can't cross-reference. Worth confirming.

---

## E. Concrete repro

### E1. The DOWNGRADE row in the screenshot is unrelated

Important clarification: looking at the user's `/transactions` screenshot, there are TWO rows:

1. **The current QUICK disconnect test** — labeled `Disconnection`, status `Pending Admin Approval`, CRM order `—` (no service order created on either side).
2. **An older DOWNGRADE row from May 16** — labeled `Downgrade`, status `Completed`, CRM order `SO/16/05/26-0026`.

The DOWNGRADE row is from a prior test exercising the standard upgrade/downgrade flow, which DOES use `POST /service-orders` (that's by design — SAM is the order-creator for UPGRADE/DOWNGRADE/RATE_REVISION; only QUICK disconnect was supposed to flip to CRM auto-creation).

**So the DOWNGRADE row is not a duplicate caused by the QUICK flow.** It's a separate, intentionally-created service order from a different test.

### E1 (actual). Exact JSON the QUICK test sent

From SAM's audit log, the outbound `quickDisconnect.requested` for the most recent test:

```
HTTP POST
URL: http://localhost:5001/webhooks/sam/quick-disconnect.requested
Headers:
  Content-Type: application/json
  X-SAM-Signature: <hex hmac of `${ts}.${rawBody}` using CRM_WEBHOOK_SECRET>
  X-SAM-Timestamp: <unix seconds>

Body:
{
  "eventId": "e9239958-5e9b-4a4f-ae25-b63d2124b324",
  "eventType": "quickDisconnect.requested",
  "occurredAt": "2026-05-20T08:07:22.817Z",
  "commercialChangeId": "ee0e7a5b-05b2-438e-b537-e0d555f81727",
  "customer": { "externalId": "d8177a9d-838f-401a-808e-eb832f994de3" },
  "raisedBy": {
    "id": "d7792fe5-4e36-49d0-a62e-d65b7cefe90b",
    "email": "kishan@gazonindia.com"
  },
  "reason": "testing this",
  "disconnectionCategoryId": "office-closed",
  "disconnectionSubCategoryId": "office-closed",
  "requested": {
    "arc": 80000,
    "days": 1
  }
}

CRM response: 201 Created  (audit_logs row stamped outcome=SENT)
```

And `POST /service-orders` was **NOT called** for this row (because we now rely on CRM auto-creation on the new event).

---

## What SAM expects from CRM going forward

This is the part you specifically asked for re-emphasising.

### 1. Single-URL dispatcher

SAM now exposes a dispatcher endpoint so you only need ONE config:

```
POST https://sam-api.gazonindia.com/webhooks/crm/event       # prod
POST http://localhost:5500/webhooks/crm/event                # local
```

Set this as your `SAM_WEBHOOK_URL`. Drop the per-event overrides (`SAM_QUICK_DISCONNECT_DECIDED_URL`, `SAM_COMMERCIAL_CHANGE_STATUS_URL`). The dispatcher reads `body.eventType` and routes internally. Adding new events in the future = zero CRM config change.

### 2. Status tracking — fire `commercialChange.statusChanged` on EVERY transition

This is critical and is the gap that's currently breaking the test. SAM expects to receive a `commercialChange.statusChanged` webhook every time the service order changes state on CRM side. Specifically:

| Transition | Webhook expected |
|---|---|
| Admin clicks Approve in Quick Disconnects inbox | `toStatus=PENDING_DOCS_REVIEW`, with `serviceOrderId` populated (CRM just created it) |
| Docs reviewer marks docs cleared | `toStatus=PENDING_NOC` |
| NOC team completes disconnection | `toStatus=PENDING_ACCOUNTS` |
| Accounts closes billing | `toStatus=COMPLETED` |
| Admin or any reviewer rejects | `toStatus=REJECTED` / `DOCS_REJECTED` / `NOC_REJECTED` with `note` populated |
| Admin cancels mid-workflow | `toStatus=CANCELLED` with `note` |

Without these webhooks SAM's `/transactions` row stays stuck on "Pending Admin Approval" forever — which is exactly the bug we just hit. Every CRM state change MUST fire an outbound webhook to SAM at the dispatcher URL.

SAM's behaviour on each webhook:

| `toStatus` received | SAM-side effect |
|---|---|
| `PENDING_DOCS_REVIEW` | Account → DISCONNECTING. Stamp `quick_approval_decision=APPROVED`, `scheduled_termination_at = today + quickRequestedDays`. Show "Docs Review" pill. |
| `PENDING_NOC` | Show "NOC" pill. Account stays DISCONNECTING. |
| `PENDING_ACCOUNTS` | Show "Accounts" pill. Account stays DISCONNECTING. |
| `COMPLETED` | Account → TERMINATED. SAM fires `customer.disconnected` back to CRM. Show "Completed" pill. |
| `REJECTED` (stage 1) | Account → ACTIVE, stamp `quick_approval_decision=REJECTED`, store the note. |
| `DOCS_REJECTED` / `NOC_REJECTED` / `CANCELLED` | Account → ACTIVE (hard revert per spec §4.1). Store the note. |

### 3. Replay failed deliveries

There are currently failed `commercialChange.statusChanged` rows in your `SamWebhookLog` from when SAM didn't have the handler. Once you point `SAM_WEBHOOK_URL` at the new dispatcher and restart, replay them via `POST /api/admin/sam-webhook/replay/:id`. SAM is idempotent on `eventId` — replays of already-applied events return 200 `{ deduped: true }`, no double-application.

### 4. Outstanding items (no urgency, can come later)

- `customer.disconnected` (SAM → CRM) — fires when SAM's sweep terminates the account. Will be the next PR on the SAM side; awaits your inbound receiver per CRM session's earlier scoping.
- Update the original `sam-quick-disconnect-contract.md` to list `disconnectionCategoryId`, `disconnectionSubCategoryId`, and `requested.days` as required fields.

---

## Action items for CRM team

- [ ] Set `SAM_WEBHOOK_URL=https://sam-api.gazonindia.com/webhooks/crm/event` (or `http://localhost:5500/webhooks/crm/event` for local)
- [ ] Restart CRM backend
- [ ] Replay the failed `commercialChange.statusChanged` deliveries
- [ ] Confirm the workflow now fires a webhook on every transition (especially the post-NOC and post-Accounts transitions — those are the ones whose status SAM never sees today)
- [ ] Update the `sam-quick-disconnect-contract.md` field table to include `disconnectionCategoryId`, `disconnectionSubCategoryId`, `requested.days`
- [ ] Confirm `serviceOrderId` and `serviceOrderNumber` are included in `commercialChange.statusChanged` payloads from stage 2 onwards

Once all checked, the round-trip works end-to-end with no further coordination needed.
