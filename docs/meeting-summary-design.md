# Meeting Summary — design spec

_Date: 2026-08-05_

## Goal

A dedicated **Meeting Summary** page for leadership that answers, for any time
window: how many meetings each SAM held, split online vs offline, plus meeting
coverage and MOM turnaround. Moves meeting analytics out of Team Performance so
each page stays focused.

## Access

- Visible to: `ADMIN`, `SUPER_ADMIN_2`, `SAM_HEAD`.
- Hidden from `SAM` and `ACCOUNTS` (no sidebar entry; backend returns 403).
- Scope of SAMs shown:
  - `ADMIN` / `SUPER_ADMIN_2` → all SAMs (org-wide).
  - `SAM_HEAD` → only their direct reports (`user.samHeadId === requester.id`).
  - Mirrors the scoping already used by `computeTeamPerformance`.

## Time filter

A range applied to meetings by **`heldAt`** (when the meeting actually took
place — not `scheduledAt`).

Presets:
- **All time** (default) — no lower/upper bound; every held meeting in scope.
- **Last month** — the previous full calendar month.
- **Custom** — explicit `from` / `to` date pickers (inclusive days).

Wire format: URL query `?preset=all|last_month|custom` and, for custom,
`&from=YYYY-MM-DD&to=YYYY-MM-DD`. Server component reads the query and re-fetches
(same SSR pattern as the rest of the app). Invalid/missing → `all`.

## Metrics

All windowed to the selected range, over **held** meetings (`heldAt` set) unless
noted.

Team KPI cards:
1. **Meetings Held** — count, with a sub-line `X online · Y offline`.
2. **Customers Met** — distinct `accountId` among held meetings in range.
3. **Avg MOM Turnaround** — mean of `momSentAt − heldAt` over held meetings that
   have a MOM sent. Rendered `1.3 days` / `18h`; `—` when none.

Charts:
1. **Meetings held per SAM** — horizontal stacked bar (online vs offline).
   Moved here from Team Performance.
2. **Meetings per month (last 6 months)** — stacked online/offline bar. Always
   the trailing 6 calendar months regardless of the range filter (the
   "month-wise" view). Independent of the range picker by design.

Per-SAM table:
`SAM | Held | Online | Offline | Customers Met | Avg MOM Turnaround`
— one row per in-scope SAM, including SAMs with `0/0/0` (leadership wants to see
who held nothing).

## Backend

New endpoint: `GET /dashboard/meeting-summary`
Query: `from?`, `to?` (ISO dates; absence ⇒ all-time). Controller resolves the
preset on the frontend, so backend only sees concrete `from`/`to` (or neither).

New service `computeMeetingSummary({ from, to, requester })`:
1. Resolve in-scope SAM ids from `requester.role` (same helper logic as
   team-performance).
2. One query: held meetings for accounts owned by those SAMs, `heldAt` within
   `[from, to]` when bounds present. Select `accountId`, `heldAt`, `momSentAt`,
   `meetingType`, and the owning SAM id (via `account.samOwnerId`).
3. Aggregate in JS → per-SAM `{ held, online, offline, customersMet,
   avgMomTurnaroundHours | null }` and team totals.
4. Second lightweight query for the 6-month trend: held meetings in the trailing
   6 months across the same scope, grouped by `YYYY-MM` + `meetingType` in JS.

Response shape:
```ts
{
  range: { from: string | null; to: string | null; preset: 'all'|'last_month'|'custom' };
  team: { held: number; online: number; offline: number;
          customersMet: number; avgMomTurnaroundHours: number | null };
  sams: Array<{ samId: string; name: string; held: number; online: number;
                offline: number; customersMet: number;
                avgMomTurnaroundHours: number | null }>;
  trend: Array<{ month: string; online: number; offline: number }>; // 6 entries, oldest→newest
}
```

Notes:
- `avgMomTurnaroundHours` computed in hours server-side; frontend formats.
- Distinct customers is per-scope (team) and per-SAM (row) independently.
- Timezone: use the same `new Date()` boundary handling as existing dashboard
  code; month boundaries for "last month" / trend computed on the server clock.

## Frontend

- Route `app/meeting-summary/page.tsx` — server component, `getMe` gate +
  role check, reads `searchParams`, calls the service wrapper with
  `cookieHeader`, renders cards + charts + table.
- Service wrapper `services/meeting-summary.ts` (typed, threads `cookieHeader`).
- Filter UI: small client component (preset buttons + custom from/to inputs)
  that pushes query params via `router.replace` → SSR re-fetch.
- Charts reuse Recharts; `MeetingsPerSamChart` generalised/moved from
  `team-charts.tsx`; new `MeetingsTrendChart`.
- Sidebar: add `{ label: 'Meeting Summary', href: '/meeting-summary',
  roles: ['ADMIN','SUPER_ADMIN_2','SAM_HEAD'] }`.

## Change to Team Performance

Remove only the `MeetingsPerSamChart` render from
`app/team-performance/page.tsx` (it now lives on Meeting Summary). The meetings
KPI card and the per-SAM table meeting columns stay — they're part of the
reliability picture.

## Edge cases

- No meetings in range → cards show `0`, charts show existing empty state, table
  lists SAMs as `0/0/0`.
- Avg turnaround with no MOMs sent → `null` → `—`.
- Custom range with `from > to` → treat as invalid, fall back to all-time.
- SAM_HEAD with no reports → empty SAM list, cards all zero.

## Out of scope (deferred)

- MOM on-time % / MOMs-pending (not requested this round).
- Scheduled-vs-held completion / no-show tracking.
- Per-SAM self-view for the `SAM` role.
