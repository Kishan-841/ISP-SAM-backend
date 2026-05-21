import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';
import {
  getCrmClient,
  CrmHttpError,
  type BdmAssignable,
  type CreateLeadInput,
} from '../../services/integrations/crm/index.js';

export type LeadFormInput = {
  companyName: string;
  contactName: string;
  phone: string;
  email?: string;
  designation?: string;
  industry?: string;
  city?: string;
  notes?: string;
  /** Must be one of the IDs returned by listBdms(). The service trusts the
   *  controller to have validated this, but it's defensive against bad calls. */
  assignedToUserId: string;
  /** Echoed onto the dispatch row + sent to CRM for their audit. */
  assignedToName: string;
  assignedToType: 'TEAM_LEADER' | 'SOLO_BDM';
  /** The SAM operator submitting. */
  performedBy: { id: string; name: string; email: string };
};

export type DispatchResult = {
  status: 'SENT' | 'DEDUPED' | 'FAILED';
  dispatchId: string;
  samLeadId: string;
  crmLeadId: string | null;
  crmLeadNumber: string | null;
  errorReason: string | null;
};

function isFeatureEnabled(): boolean {
  return process.env.LEAD_DISPATCH_ENABLED === 'true';
}

export const leadsService = {
  /**
   * Surface the list of BDMs the SAM operator can assign a lead to. Pulled
   * fresh from CRM each call — the list changes as BDMs join/leave teams.
   *
   * When LEAD_DISPATCH_ENABLED is off this still works (operator can preview
   * the dropdown) but commit() refuses.
   */
  async listBdms(): Promise<BdmAssignable[]> {
    try {
      return await getCrmClient().listAssignableBdms();
    } catch (err) {
      // BDM list failures bubble up so the controller can return a friendly
      // 502 — there's no point falling back to stale cache, an empty list,
      // or anything else: without BDMs the operator can't pick one.
      throw err;
    }
  },

  /**
   * Persist the SAM-side dispatch row, then forward to CRM. Best-effort —
   * the dispatch row is created BEFORE the CRM call so a failed call still
   * shows up in the operator's "Leads I created" history with a clear
   * errorReason. On success the row is updated with CRM's lead id/number.
   *
   * Idempotency note: SAM generates `samLeadId` once per logical submit
   * (the frontend passes a fresh UUID per form mount). CRM also dedupes on
   * samLeadId, so a double-click → second call returns DEDUPED — we update
   * the existing row's outcome rather than inserting a second one.
   */
  async commit(input: LeadFormInput): Promise<DispatchResult> {
    if (!isFeatureEnabled()) {
      throw new Error(
        'LEAD_DISPATCH_DISABLED: Lead-from-SAM is not enabled on this environment. Set LEAD_DISPATCH_ENABLED=true on the backend once the CRM-side endpoints are live.',
      );
    }

    // 1. Mint a samLeadId we own. CRM dedupes on it. We store it on the
    //    dispatch row so a re-submit (same operator, same form) can be
    //    detected before we even talk to CRM.
    const samLeadId = crypto.randomUUID();

    // 2. Persist the dispatch row up-front with status=FAILED + a placeholder
    //    error. We'll flip to SENT (or update the error) once CRM answers.
    //    Doing this BEFORE the CRM call means a network failure still leaves
    //    a discoverable row for the operator + admin.
    const dispatchRow = await prisma.samLeadDispatch.create({
      data: {
        samLeadId,
        companyName: input.companyName,
        contactName: input.contactName,
        phone: input.phone,
        email: input.email ?? null,
        designation: input.designation ?? null,
        industry: input.industry ?? null,
        city: input.city ?? null,
        notes: input.notes ?? null,
        assignedToUserId: input.assignedToUserId,
        assignedToName: input.assignedToName,
        assignedToType: input.assignedToType,
        status: 'FAILED',
        errorReason: 'Pending CRM response',
        createdById: input.performedBy.id,
      },
    });

    // 3. Forward to CRM.
    const crmInput: CreateLeadInput = {
      samLeadId,
      assignedTo: { userId: input.assignedToUserId, userType: input.assignedToType },
      lead: {
        companyName: input.companyName,
        contactName: input.contactName,
        phone: input.phone,
        email: input.email,
        designation: input.designation,
        industry: input.industry,
        city: input.city,
        notes: input.notes,
      },
      source: {
        system: 'SAM',
        createdBy: {
          id: input.performedBy.id,
          name: input.performedBy.name,
          email: input.performedBy.email,
        },
        createdAt: new Date().toISOString(),
      },
    };

    try {
      const lead = await getCrmClient().createLead(crmInput);
      const status: 'SENT' | 'DEDUPED' = lead.deduped ? 'DEDUPED' : 'SENT';
      await prisma.samLeadDispatch.update({
        where: { id: dispatchRow.id },
        data: {
          status,
          crmLeadId: lead.id,
          crmLeadNumber: lead.leadNumber,
          errorReason: null,
        },
      });
      await writeAudit(dispatchRow.id, input.performedBy.id, {
        outcome: status,
        samLeadId,
        crmLeadId: lead.id,
        crmLeadNumber: lead.leadNumber,
        assignedToName: input.assignedToName,
      });
      return {
        status,
        dispatchId: dispatchRow.id,
        samLeadId,
        crmLeadId: lead.id,
        crmLeadNumber: lead.leadNumber,
        errorReason: null,
      };
    } catch (err) {
      const errorReason =
        err instanceof CrmHttpError
          ? `CRM ${err.statusCode}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'CRM call failed';
      await prisma.samLeadDispatch.update({
        where: { id: dispatchRow.id },
        data: { status: 'FAILED', errorReason },
      });
      await writeAudit(dispatchRow.id, input.performedBy.id, {
        outcome: 'FAILED',
        samLeadId,
        errorReason,
        assignedToName: input.assignedToName,
      });
      return {
        status: 'FAILED',
        dispatchId: dispatchRow.id,
        samLeadId,
        crmLeadId: null,
        crmLeadNumber: null,
        errorReason,
      };
    }
  },

  /**
   * "Leads I created" history for the operator. SAM_HEAD / ADMIN see all
   * dispatches; regular SAM users only see their own.
   */
  async listDispatches(opts: {
    requester: { id: string; role: 'ADMIN' | 'SAM_HEAD' | 'SAM' };
    limit?: number;
  }) {
    const where =
      opts.requester.role === 'SAM' ? { createdById: opts.requester.id } : undefined;
    return prisma.samLeadDispatch.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: opts.limit ?? 50,
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
  },
};

async function writeAudit(
  dispatchId: string,
  performedBy: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        entityType: 'SamLeadDispatch',
        entityId: dispatchId,
        action: 'SAM_LEAD_DISPATCHED',
        performedBy,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  } catch {
    // Audit failure shouldn't surface as a user-facing error.
  }
}
