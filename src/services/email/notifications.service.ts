import type { Account, CommercialChangeType, Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { getEmailClient, type EmailMessage, type SendResult } from './email-client.js';
import { buildCommercialChangeAlertEmail } from './templates/commercial-change-alert.js';
import { buildCustomerAssignedEmail } from './templates/customer-assigned.js';
import { buildCustomerActivatedEmail } from './templates/customer-activated.js';
import {
  buildCrmStatusChangeEmail,
  type CrmStatusChangeKind,
} from './templates/crm-status-change.js';

/**
 * One central place for every outbound notification the platform fires.
 *
 * Design contract:
 *  - Every function is best-effort. They never throw — caller's database
 *    write must NOT roll back because email failed.
 *  - Every call writes a `NOTIFY_*` audit_log row with one of four outcomes:
 *      SENT          — transport returned ok
 *      SKIPPED       — kill switch off (NOTIFICATIONS_ENABLED env)
 *      MISCONFIGURED — kill switch on but recipient resolution failed
 *      FAILED        — transport returned ok=false (rate-limited, 5xx, etc.)
 *  - The actual transport is the LoggingEmailClient stub today; flipping
 *    it to a real Resend client is a one-line swap in email-client.ts.
 */

type AuditOutcome = 'SENT' | 'SKIPPED' | 'MISCONFIGURED' | 'FAILED';

const ENABLED_KEY = 'ACCOUNTS_NOTIFICATIONS_ENABLED';

function isEnabled(): boolean {
  return process.env[ENABLED_KEY] === 'true';
}

function parseEmailList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

async function dispatch(opts: {
  message: EmailMessage;
  audit: {
    entityType: string;
    entityId: string;
    action: string; // e.g. 'NOTIFY_ACCOUNTS_TEAM', 'NOTIFY_CUSTOMER_ASSIGNED'
    performedBy: string;
    extraPayload?: Record<string, unknown>;
  };
}): Promise<{ status: 'sent' | 'failed'; messageId?: string; error?: string }> {
  let result: SendResult;
  try {
    result = await getEmailClient().send(opts.message);
  } catch (err) {
    // Defensive — clients are contracted to never throw, but if one does
    // we treat it as a failure rather than letting it bubble.
    result = { ok: false, error: err instanceof Error ? err.message : 'send threw' };
  }

  const outcome: AuditOutcome = result.ok ? 'SENT' : 'FAILED';
  const detail = result.ok ? `messageId=${result.messageId}` : result.error;
  await writeAudit(opts.audit, outcome, detail);
  return result.ok
    ? { status: 'sent', messageId: result.messageId }
    : { status: 'failed', error: result.error };
}

async function writeAudit(
  audit: {
    entityType: string;
    entityId: string;
    action: string;
    performedBy: string;
    extraPayload?: Record<string, unknown>;
  },
  outcome: AuditOutcome,
  detail: string,
) {
  try {
    await prisma.auditLog.create({
      data: {
        entityType: audit.entityType,
        entityId: audit.entityId,
        action: audit.action,
        performedBy: audit.performedBy,
        payload: { outcome, detail, ...(audit.extraPayload ?? {}) } as Prisma.InputJsonValue,
      },
    });
  } catch {
    // Audit-log write itself shouldn't crash the request flow.
  }
}

// ─── Event 1: commercial change committed ─────────────────────────────

export async function sendCommercialChangeAlert(input: {
  commercialChangeId: string;
  account: Pick<Account, 'clientName' | 'companyName' | 'customerCode' | 'circuitId' | 'samOwnerId'>;
  changeType: CommercialChangeType;
  oldArc: number;
  newArc: number;
  effectiveDate: Date;
  samOwnerName: string;
  reason: string | null;
  performedByUserId: string;
}): Promise<{ status: AuditOutcome }> {
  const audit = {
    entityType: 'CommercialChange',
    entityId: input.commercialChangeId,
    action: 'NOTIFY_ACCOUNTS_TEAM',
    performedBy: input.performedByUserId,
  };

  if (!isEnabled()) {
    await writeAudit(audit, 'SKIPPED', `${ENABLED_KEY} is not true`);
    return { status: 'SKIPPED' };
  }
  const to = process.env.ACCOUNTS_TEAM_EMAIL;
  if (!to) {
    await writeAudit(audit, 'MISCONFIGURED', 'ACCOUNTS_TEAM_EMAIL env var is not set');
    return { status: 'MISCONFIGURED' };
  }

  // CC the SAM_HEAD that owns this account's SAM, plus any global CC list.
  const samHeadEmail = await resolveSamHeadEmail(input.account.samOwnerId);
  const envCc = parseEmailList(process.env.ACCOUNTS_TEAM_CC_EMAILS) ?? [];
  const cc = Array.from(new Set([...envCc, ...(samHeadEmail ? [samHeadEmail] : [])]));

  const { subject, html, text } = buildCommercialChangeAlertEmail(input);
  const result = await dispatch({
    message: {
      to,
      cc: cc.length > 0 ? cc : undefined,
      subject,
      html,
      text,
      meta: {
        commercialChangeId: input.commercialChangeId,
        changeType: input.changeType,
      },
    },
    audit,
  });

  if (result.status === 'sent') {
    await prisma.commercialChange.update({
      where: { id: input.commercialChangeId },
      data: { accountsNotifiedDate: new Date() },
    });
    return { status: 'SENT' };
  }
  return { status: 'FAILED' };
}

// ─── Event 2: customer assigned to a SAM ──────────────────────────────

export async function sendCustomerAssignedAlert(input: {
  accountId: string;
  account: Pick<
    Account,
    'clientName' | 'companyName' | 'customerCode' | 'circuitId' | 'currentArc' | 'bandwidthMbps'
  >;
  newOwner: { id: string; name: string; email: string };
  assignedBy: { id: string; name: string };
}): Promise<{ status: AuditOutcome }> {
  const audit = {
    entityType: 'Account',
    entityId: input.accountId,
    action: 'NOTIFY_CUSTOMER_ASSIGNED',
    performedBy: input.assignedBy.id,
    extraPayload: { newOwnerId: input.newOwner.id },
  };

  if (!isEnabled()) {
    await writeAudit(audit, 'SKIPPED', `${ENABLED_KEY} is not true`);
    return { status: 'SKIPPED' };
  }
  if (!input.newOwner.email) {
    await writeAudit(audit, 'MISCONFIGURED', 'New owner has no email address on record');
    return { status: 'MISCONFIGURED' };
  }

  const { subject, html, text } = buildCustomerAssignedEmail({
    account: input.account,
    newOwnerName: input.newOwner.name,
    assignedByName: input.assignedBy.name,
  });

  const result = await dispatch({
    message: {
      to: input.newOwner.email,
      subject,
      html,
      text,
      meta: { accountId: input.accountId, newOwnerId: input.newOwner.id },
    },
    audit,
  });
  return result.status === 'sent' ? { status: 'SENT' } : { status: 'FAILED' };
}

// ─── Event 3: customer activated from CRM ─────────────────────────────

export async function sendCustomerActivatedAlert(input: {
  accountId: string;
  account: Pick<
    Account,
    'clientName' | 'companyName' | 'customerCode' | 'circuitId' | 'currentArc' | 'bandwidthMbps'
  >;
  /** UUID stamped on the audit row. CRM webhooks have no SAM user, so we use
   *  the system uuid placeholder. */
  systemUserId: string;
}): Promise<{ status: AuditOutcome }> {
  const audit = {
    entityType: 'Account',
    entityId: input.accountId,
    action: 'NOTIFY_CUSTOMER_ACTIVATED',
    performedBy: input.systemUserId,
  };

  if (!isEnabled()) {
    await writeAudit(audit, 'SKIPPED', `${ENABLED_KEY} is not true`);
    return { status: 'SKIPPED' };
  }

  const heads = await prisma.user.findMany({
    where: { role: 'SAM_HEAD' },
    select: { email: true },
  });
  const headEmails = heads.map((h) => h.email).filter(Boolean);
  if (headEmails.length === 0) {
    await writeAudit(audit, 'MISCONFIGURED', 'No SAM_HEAD users to notify');
    return { status: 'MISCONFIGURED' };
  }

  const { subject, html, text } = buildCustomerActivatedEmail({ account: input.account });
  // First head is `to`, the rest are CC.
  const [to, ...cc] = headEmails;

  const result = await dispatch({
    message: {
      to: to!,
      cc: cc.length > 0 ? cc : undefined,
      subject,
      html,
      text,
      meta: { accountId: input.accountId, totalHeads: headEmails.length },
    },
    audit,
  });
  return result.status === 'sent' ? { status: 'SENT' } : { status: 'FAILED' };
}

// ─── Event 4: CRM status changes (activation pending / completed) ────

export async function sendCrmStatusChangeAlert(input: {
  commercialChangeId: string;
  kind: CrmStatusChangeKind;
  account: Pick<Account, 'clientName' | 'companyName' | 'customerCode' | 'circuitId' | 'samOwnerId'>;
  changeType: CommercialChangeType;
  oldArc: number;
  newArc: number;
  crmOrderNumber: string | null;
  performedByUserId: string;
}): Promise<{ status: AuditOutcome }> {
  const audit = {
    entityType: 'CommercialChange',
    entityId: input.commercialChangeId,
    action: `NOTIFY_CRM_${input.kind}`,
    performedBy: input.performedByUserId,
  };

  if (!isEnabled()) {
    await writeAudit(audit, 'SKIPPED', `${ENABLED_KEY} is not true`);
    return { status: 'SKIPPED' };
  }

  const samOwner = input.account.samOwnerId
    ? await prisma.user.findUnique({
        where: { id: input.account.samOwnerId },
        select: { name: true, email: true },
      })
    : null;

  if (!samOwner?.email) {
    await writeAudit(
      audit,
      'MISCONFIGURED',
      input.account.samOwnerId
        ? 'SAM owner has no email address on record'
        : 'Account is unassigned — no SAM to notify',
    );
    return { status: 'MISCONFIGURED' };
  }

  // For COMPLETED, also CC accounts team if configured (billing finalised).
  const cc: string[] = [];
  if (input.kind === 'COMPLETED' && process.env.ACCOUNTS_TEAM_EMAIL) {
    cc.push(process.env.ACCOUNTS_TEAM_EMAIL);
  }

  const { subject, html, text } = buildCrmStatusChangeEmail({
    kind: input.kind,
    account: input.account,
    changeType: input.changeType,
    oldArc: input.oldArc,
    newArc: input.newArc,
    crmOrderNumber: input.crmOrderNumber,
    samOwnerName: samOwner.name,
  });

  const result = await dispatch({
    message: {
      to: samOwner.email,
      cc: cc.length > 0 ? cc : undefined,
      subject,
      html,
      text,
      meta: { commercialChangeId: input.commercialChangeId, kind: input.kind },
    },
    audit,
  });
  return result.status === 'sent' ? { status: 'SENT' } : { status: 'FAILED' };
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function resolveSamHeadEmail(samOwnerId: string | null): Promise<string | null> {
  if (!samOwnerId) return null;
  const sam = await prisma.user.findUnique({
    where: { id: samOwnerId },
    select: {
      samHead: { select: { email: true } },
    },
  });
  return sam?.samHead?.email ?? null;
}
