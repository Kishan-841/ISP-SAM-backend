import type { UserRole } from '@prisma/client';
import { prisma } from '../../prisma.js';

/**
 * Meeting Summary — leadership view of meeting activity.
 *
 * Everything is measured over HELD meetings (heldAt set) so the numbers reflect
 * meetings that actually happened, not just scheduled ones. The optional
 * [from, to] window filters by heldAt. The 6-month trend is always the trailing
 * six calendar months regardless of that window.
 *
 * Scope:
 *   - SAM_HEAD  → only their direct reports.
 *   - ADMIN / SUPER_ADMIN_2 → every SAM (org-wide).
 * Mirrors computeTeamPerformance's scoping.
 */

export type MeetingSummarySamRow = {
  samId: string;
  name: string;
  held: number;
  online: number;
  offline: number;
  customersMet: number;
  /** Mean hours from heldAt → momSentAt over held meetings with a MOM. null if none. */
  avgMomTurnaroundHours: number | null;
};

export type MeetingSummary = {
  range: { from: string | null; to: string | null };
  team: {
    held: number;
    online: number;
    offline: number;
    customersMet: number;
    avgMomTurnaroundHours: number | null;
  };
  sams: MeetingSummarySamRow[];
  /** Trailing 6 months, oldest → newest. month = "YYYY-MM". */
  trend: Array<{ month: string; online: number; offline: number }>;
};

type HeldMeeting = {
  accountId: string;
  heldAt: Date | null;
  momSentAt: Date | null;
  meetingType: 'ONLINE' | 'PHYSICAL';
};

const HOUR_MS = 60 * 60 * 1000;

/** Mean heldAt→momSentAt gap in hours over meetings that have a MOM sent. */
function avgTurnaroundHours(meetings: HeldMeeting[]): number | null {
  const diffs: number[] = [];
  for (const m of meetings) {
    if (!m.heldAt || !m.momSentAt) continue;
    const diff = (m.momSentAt.getTime() - m.heldAt.getTime()) / HOUR_MS;
    if (diff >= 0) diffs.push(diff); // ignore MOM-before-meeting data quirks
  }
  if (diffs.length === 0) return null;
  return diffs.reduce((s, d) => s + d, 0) / diffs.length;
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function computeMeetingSummary({
  from,
  to,
  requester,
}: {
  from: Date | null;
  to: Date | null;
  requester: { id: string; role: UserRole };
}): Promise<MeetingSummary> {
  const range = {
    from: from ? from.toISOString() : null,
    to: to ? to.toISOString() : null,
  };

  // 1. Scope SAMs by requester role.
  const sams = await prisma.user.findMany({
    where:
      requester.role === 'SAM_HEAD'
        ? { role: 'SAM', samHeadId: requester.id }
        : { role: 'SAM' },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const samIds = sams.map((s) => s.id);

  if (samIds.length === 0) {
    return {
      range,
      team: { held: 0, online: 0, offline: 0, customersMet: 0, avgMomTurnaroundHours: null },
      sams: [],
      trend: buildEmptyTrend(),
    };
  }

  // 2. Held meetings within the window, plus the trailing-6-month trend set.
  const now = new Date();
  const trendStart = new Date(now.getFullYear(), now.getMonth() - 5, 1, 0, 0, 0, 0);

  const [windowMeetings, trendMeetings] = await Promise.all([
    prisma.meeting.findMany({
      where: {
        account: { samOwnerId: { in: samIds } },
        heldAt: { not: null, ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) },
      },
      select: {
        accountId: true,
        heldAt: true,
        momSentAt: true,
        meetingType: true,
        account: { select: { samOwnerId: true } },
      },
    }),
    prisma.meeting.findMany({
      where: {
        account: { samOwnerId: { in: samIds } },
        heldAt: { not: null, gte: trendStart },
      },
      select: { heldAt: true, meetingType: true },
    }),
  ]);

  // 3. Per-SAM aggregation.
  const bySam = new Map<string, HeldMeeting[]>();
  for (const m of windowMeetings) {
    const ownerId = m.account.samOwnerId;
    if (!ownerId) continue;
    const arr = bySam.get(ownerId) ?? [];
    arr.push({
      accountId: m.accountId,
      heldAt: m.heldAt,
      momSentAt: m.momSentAt,
      meetingType: m.meetingType,
    });
    bySam.set(ownerId, arr);
  }

  const samRows: MeetingSummarySamRow[] = sams.map((s) => {
    const held = bySam.get(s.id) ?? [];
    const online = held.filter((m) => m.meetingType === 'ONLINE').length;
    const offline = held.filter((m) => m.meetingType === 'PHYSICAL').length;
    const customersMet = new Set(held.map((m) => m.accountId)).size;
    return {
      samId: s.id,
      name: s.name,
      held: held.length,
      online,
      offline,
      customersMet,
      avgMomTurnaroundHours: avgTurnaroundHours(held),
    };
  });

  // 4. Team totals (computed from the full window set, not summed rows, so
  //    distinct-customers is correct org-wide).
  const allWindow: HeldMeeting[] = windowMeetings.map((m) => ({
    accountId: m.accountId,
    heldAt: m.heldAt,
    momSentAt: m.momSentAt,
    meetingType: m.meetingType,
  }));
  const team = {
    held: allWindow.length,
    online: allWindow.filter((m) => m.meetingType === 'ONLINE').length,
    offline: allWindow.filter((m) => m.meetingType === 'PHYSICAL').length,
    customersMet: new Set(allWindow.map((m) => m.accountId)).size,
    avgMomTurnaroundHours: avgTurnaroundHours(allWindow),
  };

  // 5. Trailing-6-month trend, zero-filled.
  const trend = buildEmptyTrend(now);
  const byMonth = new Map(trend.map((t) => [t.month, t]));
  for (const m of trendMeetings) {
    if (!m.heldAt) continue;
    const bucket = byMonth.get(monthKey(m.heldAt));
    if (!bucket) continue;
    if (m.meetingType === 'ONLINE') bucket.online += 1;
    else bucket.offline += 1;
  }

  return { range, team, sams: samRows, trend };
}

/** Six month buckets oldest → newest, all zero. */
function buildEmptyTrend(now: Date = new Date()): Array<{ month: string; online: number; offline: number }> {
  const out: Array<{ month: string; online: number; offline: number }> = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ month: monthKey(d), online: 0, offline: 0 });
  }
  return out;
}
