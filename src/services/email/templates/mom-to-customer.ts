import type { Account, MeetingType } from '@prisma/client';
import { escapeHtml, plainBodyToHtml, wrapEmailShell } from './_helpers.js';

export type Participant = { name: string; position?: string };

export type ActionItem = {
  srNo: number;
  discussionDescription: string;
  actionOwner: string;
  planOfAction: string;
  closureDate: string | null;
  currentStatus: 'Open' | 'In Progress' | 'Closed';
};

export type MomToCustomerInput = {
  account: Pick<Account, 'clientName' | 'companyName' | 'customerCode' | 'circuitId'>;
  samName: string;
  meetingScheduledAt: Date;
  meetingHeldAt: Date | null;
  meetingType: MeetingType;
  location: string | null;
  clientParticipants: Participant[];
  gazonParticipants: Participant[];
  actionItems: ActionItem[];
  momContent: string;
  /** Override the generated subject. Empty/whitespace = use default. */
  subjectOverride?: string | null;
  samDesignation?: string | null;
  samPhone?: string | null;
};

const DATE_FMT = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const TIME_FMT = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

function formatDate(d: Date): string {
  return DATE_FMT.format(d);
}
function formatTime(d: Date): string {
  return TIME_FMT.format(d).toLowerCase();
}

// ─── Section helpers ──────────────────────────────────────────────────

function renderKeyValueRow(label: string, value: string): string {
  return `
    <tr>
      <td style="padding:6px 0;width:140px;color:#6b7280;font-size:14px;">${escapeHtml(label)}:</td>
      <td style="padding:6px 0;color:#111827;font-size:14px;font-weight:600;">${escapeHtml(value)}</td>
    </tr>`;
}

const STATUS_PILL: Record<ActionItem['currentStatus'], { bg: string; text: string }> = {
  Open: { bg: '#fee2e2', text: '#991b1b' },
  'In Progress': { bg: '#fef3c7', text: '#92400e' },
  Closed: { bg: '#d1fae5', text: '#065f46' },
};

function renderStatusPill(status: ActionItem['currentStatus']): string {
  const c = STATUS_PILL[status];
  return `<span style="display:inline-block;padding:4px 10px;font-size:12px;font-weight:600;border-radius:9999px;background:${c.bg};color:${c.text};">${escapeHtml(status)}</span>`;
}

function renderParticipantsTable(
  client: Participant[],
  gazon: Participant[],
  clientOrgName: string,
): string {
  const rows = [
    ...client.map((p) => ({ ...p, org: clientOrgName })),
    ...gazon.map((p) => ({ ...p, org: 'Gazon Communications' })),
  ];
  if (rows.length === 0) return '';

  const rowsHtml = rows
    .map(
      (r, idx) => `
    <tr style="background:${idx % 2 === 0 ? '#ffffff' : '#f9fafb'};">
      <td style="padding:12px 14px;font-size:13px;color:#111827;border-top:1px solid #f3f4f6;">${idx + 1}</td>
      <td style="padding:12px 14px;font-size:13px;color:#111827;border-top:1px solid #f3f4f6;">${escapeHtml(r.name)}</td>
      <td style="padding:12px 14px;font-size:13px;color:#374151;border-top:1px solid #f3f4f6;">${escapeHtml(r.org)}</td>
    </tr>`,
    )
    .join('');

  return `
    <div style="margin:8px 0 8px;">
      <div style="font-size:15px;font-weight:700;color:#111827;margin-bottom:10px;">Participants</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#ea580c;color:#ffffff;">
            <th style="padding:12px 14px;text-align:left;font-size:12px;font-weight:600;letter-spacing:0.02em;">Sr No</th>
            <th style="padding:12px 14px;text-align:left;font-size:12px;font-weight:600;letter-spacing:0.02em;">Name</th>
            <th style="padding:12px 14px;text-align:left;font-size:12px;font-weight:600;letter-spacing:0.02em;">Organisation</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}

function renderActionItemsTable(items: ActionItem[]): string {
  if (items.length === 0) return '';
  const rowsHtml = items
    .map(
      (it, idx) => `
    <tr style="background:${idx % 2 === 0 ? '#ffffff' : '#f9fafb'};">
      <td style="padding:12px 14px;font-size:13px;color:#111827;border-top:1px solid #f3f4f6;vertical-align:top;">${idx + 1}</td>
      <td style="padding:12px 14px;font-size:13px;color:#111827;border-top:1px solid #f3f4f6;vertical-align:top;">${escapeHtml(it.discussionDescription)}</td>
      <td style="padding:12px 14px;font-size:13px;color:#374151;border-top:1px solid #f3f4f6;vertical-align:top;">${escapeHtml(it.actionOwner || '—')}</td>
      <td style="padding:12px 14px;font-size:13px;color:#374151;border-top:1px solid #f3f4f6;vertical-align:top;">${escapeHtml(it.planOfAction || '—')}</td>
      <td style="padding:12px 14px;font-size:13px;color:#374151;border-top:1px solid #f3f4f6;vertical-align:top;white-space:nowrap;">${escapeHtml(it.closureDate || '—')}</td>
      <td style="padding:12px 14px;border-top:1px solid #f3f4f6;vertical-align:top;">${renderStatusPill(it.currentStatus)}</td>
    </tr>`,
    )
    .join('');

  return `
    <div style="margin:18px 0 8px;">
      <div style="font-size:15px;font-weight:700;color:#111827;margin-bottom:10px;">Action Items</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#ea580c;color:#ffffff;">
            <th style="padding:12px 14px;text-align:left;font-size:12px;font-weight:600;letter-spacing:0.02em;">SR No</th>
            <th style="padding:12px 14px;text-align:left;font-size:12px;font-weight:600;letter-spacing:0.02em;">Issue Description</th>
            <th style="padding:12px 14px;text-align:left;font-size:12px;font-weight:600;letter-spacing:0.02em;">Action Owner</th>
            <th style="padding:12px 14px;text-align:left;font-size:12px;font-weight:600;letter-spacing:0.02em;">Plan of Action</th>
            <th style="padding:12px 14px;text-align:left;font-size:12px;font-weight:600;letter-spacing:0.02em;">Closure Date</th>
            <th style="padding:12px 14px;text-align:left;font-size:12px;font-weight:600;letter-spacing:0.02em;">Status</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}

// ─── Plain-text fallback ──────────────────────────────────────────────

function plainTextVersion(input: MomToCustomerInput): string {
  const heldOrScheduled = input.meetingHeldAt ?? input.meetingScheduledAt;
  const customerName = input.account.companyName || input.account.clientName;
  const lines: string[] = [];
  lines.push(`Minutes of Meeting — ${customerName}`);
  lines.push('');
  lines.push(`Date:  ${formatDate(heldOrScheduled)}`);
  lines.push(`Time:  ${formatTime(heldOrScheduled)}`);
  lines.push(`Type:  ${input.meetingType === 'PHYSICAL' ? 'Physical' : 'Online'}`);
  if (input.meetingType === 'PHYSICAL' && input.location) {
    lines.push(`Venue: ${input.location}`);
  }
  lines.push('');

  const allPpts = [
    ...input.clientParticipants.map((p) => ({
      ...p,
      org: customerName,
    })),
    ...input.gazonParticipants.map((p) => ({ ...p, org: 'Gazon Communications' })),
  ];
  if (allPpts.length > 0) {
    lines.push('Participants:');
    allPpts.forEach((p, i) => {
      lines.push(`  ${i + 1}. ${p.name} — ${p.org}`);
    });
    lines.push('');
  }

  if (input.actionItems.length > 0) {
    lines.push('Action Items:');
    input.actionItems.forEach((a, i) => {
      lines.push(
        `  ${i + 1}. [${a.currentStatus}] ${a.discussionDescription} — Owner: ${a.actionOwner || '—'}, Plan: ${a.planOfAction || '—'}, Closure: ${a.closureDate || '—'}`,
      );
    });
    lines.push('');
  }

  if (input.momContent.trim()) {
    lines.push(input.momContent.trim());
    lines.push('');
  }
  lines.push('Thank you for your time. Please feel free to reach out for any clarifications.');
  lines.push('');
  lines.push('Best Regards,');
  lines.push(input.samName);
  if (input.samDesignation?.trim()) {
    lines.push(`${input.samDesignation.trim()} - Gazon Communications`);
  } else {
    lines.push('Gazon Communications India Ltd.');
  }
  if (input.samPhone?.trim()) lines.push(`Phone: ${input.samPhone.trim()}`);
  return lines.join('\n');
}

// ─── Main entry ───────────────────────────────────────────────────────

export function buildMomToCustomerEmail(input: MomToCustomerInput): {
  subject: string;
  html: string;
  text: string;
} {
  const customerName = input.account.companyName || input.account.clientName;
  const heldOrScheduled = input.meetingHeldAt ?? input.meetingScheduledAt;
  const defaultSubject = `Minutes of Meeting — ${customerName} — ${formatDate(heldOrScheduled)}`;
  const subject = input.subjectOverride?.trim() || defaultSubject;

  const designation = input.samDesignation?.trim();
  const phone = input.samPhone?.trim();

  const detailRows: string[] = [
    renderKeyValueRow('Date', formatDate(heldOrScheduled)),
    renderKeyValueRow('Time', formatTime(heldOrScheduled)),
    renderKeyValueRow(
      'Type',
      input.meetingType === 'PHYSICAL' ? 'Physical' : 'Online',
    ),
  ];
  if (input.meetingType === 'PHYSICAL' && input.location) {
    detailRows.push(renderKeyValueRow('Venue', input.location));
  }

  const participantsHtml = renderParticipantsTable(
    input.clientParticipants,
    input.gazonParticipants,
    customerName,
  );
  const actionItemsHtml = renderActionItemsTable(input.actionItems);
  const bodyHtml = input.momContent.trim() ? plainBodyToHtml(input.momContent) : '';

  const bodyFragment = `
    <tr>
      <td style="padding:0;background:#ea580c;">
        <div style="padding:28px 32px;">
          <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">Minutes of Meeting</div>
          <div style="margin-top:8px;font-size:14px;color:#ffedd5;">${escapeHtml(customerName)}</div>
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding:28px 32px;background:#ffffff;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:24px;">
          ${detailRows.join('')}
        </table>

        ${participantsHtml}
        ${actionItemsHtml}

        ${bodyHtml ? `<div style="margin:18px 0 0;">${bodyHtml}</div>` : ''}

        <p style="margin:24px 0 0;font-size:14px;color:#374151;line-height:1.6;">
          Thank you for your time. Please feel free to reach out for any clarifications.
        </p>

        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />

        <p style="margin:0;font-size:14px;color:#111827;">Best Regards,</p>
        <p style="margin:4px 0 0;font-size:15px;font-weight:700;color:#ea580c;">${escapeHtml(input.samName)}</p>
        <p style="margin:2px 0 0;font-size:13px;color:#6b7280;">${
          designation
            ? `${escapeHtml(designation)} - Gazon Communications`
            : 'Gazon Communications India Ltd.'
        }</p>
        ${
          phone
            ? `<p style="margin:4px 0 0;font-size:13px;color:#6b7280;">Phone: ${escapeHtml(phone)}</p>`
            : ''
        }
      </td>
    </tr>`;

  const html = wrapEmailShell({
    preheader: `Minutes of meeting on ${formatDate(heldOrScheduled)} — ${customerName}`,
    bodyHtml: bodyFragment,
  });

  return { subject, html, text: plainTextVersion(input) };
}
