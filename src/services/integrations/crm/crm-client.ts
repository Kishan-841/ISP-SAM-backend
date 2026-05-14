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
  // New — service orders.
  createServiceOrder(input: CreateServiceOrderInput): Promise<ServiceOrder>;
  listServiceOrders(filters: { customerId: string }): Promise<ServiceOrder[]>;
  setActivationDate(orderId: string, activationDate: Date): Promise<ServiceOrder>;
  fetchDisconnectionReasons(): Promise<DisconnectionCategory[]>;
}
