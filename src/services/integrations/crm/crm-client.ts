import type { ContractStatus } from '@prisma/client';

export interface CrmAccount {
  externalCrmId: string;
  clientName: string;
  currentArc: number;
  contractStatus: ContractStatus;
  onboardingDate: Date;
  modifiedAt?: Date;
}

// ─── Service-order types (CRM contract) ─────────────────────────────────────

export type ServiceOrderType = 'UPGRADE' | 'DOWNGRADE' | 'RATE_REVISION' | 'DISCONNECTION';

export interface CreateServiceOrderInput {
  /** CRM lead UUID — what we stored as account.externalCrmId. */
  customerId: string;
  orderType: ServiceOrderType;
  /** Mbps integer. Required for UPGRADE/DOWNGRADE. Optional ≥ current for RATE_REVISION. */
  newBandwidth?: number;
  /** Annual ₹. Required for UPGRADE/DOWNGRADE/RATE_REVISION. */
  newArc?: number;
  /** ISO 8601. Optional. Not used for DISCONNECTION (CRM auto +30 days). */
  effectiveDate?: string;
  /** Date SAM received the customer's approval email (ISO date, no time). */
  mailReceivedDate?: string;
  notes?: string;
  /**
   * HTTPS URL to the customer-approval file in Cloudinary. Optional today
   * for backwards compatibility — the CRM team's contract makes it required
   * once their Docs review UI surfaces it.
   */
  approvalFileUrl?: string;
  /**
   * HTTPS URL to the customer's Purchase Order (PO) in Cloudinary.
   * Same Cloudinary folder, different `kind` sub-folder.
   */
  poFileUrl?: string;
  // Disconnection-only.
  disconnectionCategoryId?: string;
  disconnectionSubCategoryId?: string;
  disconnectionReason?: string;
}

export interface ServiceOrder {
  id: string;
  orderNumber: string;
  status: string;
  customerId: string;
  orderType: ServiceOrderType;
  currentBandwidth?: number;
  currentArc?: number;
  newBandwidth?: number;
  newArc?: number;
  effectiveDate?: string | null;
  activationDate?: string | null;
  disconnectionDate?: string | null;
  notes?: string | null;
  // Lifecycle timestamps (null until that stage runs).
  docsReviewedAt?: string | null;
  nocProcessedAt?: string | null;
  activationSetAt?: string | null;
  processedAt?: string | null;
}

export interface DisconnectionCategory {
  id: string;
  name: string;
  isActive: boolean;
  subCategories: { id: string; name: string; isActive: boolean }[];
}

// ─── Create-lead-from-SAM types (CRM contract §2) ───────────────────────────

export type BdmType = 'TEAM_LEADER' | 'SOLO_BDM';

/** One row from GET /api/integrations/sam/bdms. `email` may be omitted or
 *  null when CRM doesn't have one — UI degrades gracefully (name-only). */
export interface BdmAssignable {
  id: string;
  name: string;
  email?: string | null;
  type: BdmType;
}

export interface CreateLeadInput {
  samLeadId: string;
  assignedTo: { userId: string; userType?: BdmType };
  lead: {
    companyName: string;
    contactName: string;
    phone: string;
    email?: string;
    designation?: string;
    industry?: string;
    city?: string;
    notes?: string;
  };
  source: {
    system: 'SAM';
    createdBy: { id: string; name: string; email: string };
    createdAt: string; // ISO
  };
}

export interface CreatedLead {
  id: string;
  leadNumber: string;
  assignedToUserId: string;
  assignedToName: string;
  createdAt: string;
  /** True only on idempotent replay — CRM returned 200 instead of 201. */
  deduped?: boolean;
}

/** Row returned by GET /api/integrations/sam/leads (spec §2.3).
 *  Lets SAM render the "Leads I created" view — who currently owns each
 *  lead + the current CRM stage. */
export interface SamSourcedLead {
  id: string;
  leadNumber: string;
  samLeadId: string;
  companyName: string;
  contactName: string;
  phone: string;
  email: string | null;
  status: string;
  currentOwner: {
    id: string;
    name: string;
    email?: string | null;
    type: BdmType;
  };
  samCreatedById: string;
  samCreatedByName: string;
  samCreatedAt: string;
  lastUpdatedAt: string;
}

export interface ListSamLeadsResponse {
  leads: SamSourcedLead[];
  total: number;
  page: number;
  pageSize: number;
}

export class CrmHttpError extends Error {
  constructor(
    public statusCode: number,
    public body: unknown,
    public path: string,
  ) {
    super(
      `CRM ${statusCode} on ${path}: ${
        typeof body === 'object' && body && 'message' in body
          ? String((body as { message?: unknown }).message)
          : JSON.stringify(body)
      }`,
    );
    this.name = 'CrmHttpError';
  }
}

export interface CrmClient {
  // Existing — used by the customer.activated bridge.
  fetchAccount(externalCrmId: string): Promise<CrmAccount | null>;
  listAccountsModifiedSince(since: Date): Promise<CrmAccount[]>;
  // Service orders.
  createServiceOrder(input: CreateServiceOrderInput): Promise<ServiceOrder>;
  listServiceOrders(filters: { customerId: string }): Promise<ServiceOrder[]>;
  setActivationDate(orderId: string, activationDate: Date): Promise<ServiceOrder>;
  fetchDisconnectionReasons(): Promise<DisconnectionCategory[]>;
  // Create-lead-from-SAM (CRM endpoints per sam-creates-lead-spec.md §2).
  listAssignableBdms(): Promise<BdmAssignable[]>;
  createLead(input: CreateLeadInput): Promise<CreatedLead>;
  /** GET /api/integrations/sam/leads — list view with current CRM-side
   *  status + current owner per SAM-sourced lead. Per spec §2.3. */
  listSamLeads(filters: {
    samCreatedById?: string;
    limit?: number;
    page?: number;
  }): Promise<ListSamLeadsResponse>;
}
