import {
  type CrmClient,
  type CrmAccount,
  type CreateServiceOrderInput,
  type ServiceOrder,
  type DisconnectionCategory,
  type BdmAssignable,
  type CreateLeadInput,
  type CreatedLead,
  type ListSamLeadsResponse,
  type SamSourcedLead,
} from './crm-client.js';

/**
 * In-memory CrmClient. Used by tests and as the fallback when the env vars
 * for the real HTTP client aren't set. Service-order methods record what
 * was sent so tests can assert on it.
 */
export class CrmStub implements CrmClient {
  private store = new Map<string, CrmAccount>();

  /** Service orders the SAM service has created via this stub. */
  public readonly serviceOrders: ServiceOrder[] = [];
  /** Captured calls — useful for assertions in tests. */
  public readonly createServiceOrderCalls: CreateServiceOrderInput[] = [];

  /** Make the next createServiceOrder() throw — for testing 4xx surfacing. */
  public failNextCreate: { status: number; message: string } | null = null;

  /** Seed disconnection reasons for tests that exercise the dropdown flow. */
  public disconnectionReasons: DisconnectionCategory[] = [];

  seed(account: CrmAccount): void {
    this.store.set(account.externalCrmId, account);
  }

  async fetchAccount(externalCrmId: string): Promise<CrmAccount | null> {
    return this.store.get(externalCrmId) ?? null;
  }

  async listAccountsModifiedSince(since: Date): Promise<CrmAccount[]> {
    return Array.from(this.store.values()).filter(
      (a) => a.modifiedAt !== undefined && a.modifiedAt >= since,
    );
  }

  async createServiceOrder(input: CreateServiceOrderInput): Promise<ServiceOrder> {
    this.createServiceOrderCalls.push(input);
    if (this.failNextCreate) {
      const fail = this.failNextCreate;
      this.failNextCreate = null;
      const { CrmHttpError } = await import('./crm-client.js');
      throw new CrmHttpError(fail.status, { message: fail.message }, '/service-orders');
    }
    const order: ServiceOrder = {
      id: `stub-order-${this.serviceOrders.length + 1}`,
      orderNumber: `SO/STUB/${String(this.serviceOrders.length + 1).padStart(4, '0')}`,
      status: input.orderType === 'DISCONNECTION' ? 'PENDING_APPROVAL' : 'PENDING_DOCS_REVIEW',
      customerId: input.customerId,
      orderType: input.orderType,
      newBandwidth: input.newBandwidth,
      newArc: input.newArc,
      effectiveDate: input.effectiveDate ?? null,
      notes: input.notes ?? null,
    };
    this.serviceOrders.push(order);
    return order;
  }

  async listServiceOrders(filters: { customerId: string }): Promise<ServiceOrder[]> {
    return this.serviceOrders.filter((o) => o.customerId === filters.customerId);
  }

  async setActivationDate(orderId: string, activationDate: Date): Promise<ServiceOrder> {
    const order = this.serviceOrders.find((o) => o.id === orderId);
    if (!order) {
      const { CrmHttpError } = await import('./crm-client.js');
      throw new CrmHttpError(404, { message: 'Order not found' }, `/service-orders/${orderId}`);
    }
    order.status = 'PENDING_ACCOUNTS';
    order.activationDate = activationDate.toISOString().slice(0, 10);
    order.activationSetAt = new Date().toISOString();
    return order;
  }

  async fetchDisconnectionReasons(): Promise<DisconnectionCategory[]> {
    return this.disconnectionReasons;
  }

  // ─── Create-lead-from-SAM stubs ───────────────────────────────────────
  // Used by tests + the local-dev fallback so the UI works without a
  // running CRM. Seed with `seedBdms()` if a test needs specific values.

  bdms: BdmAssignable[] = [
    { id: 'bdm-tl-1', name: 'Rahul Mehta', email: 'rahul@gazonindia.com', type: 'TEAM_LEADER' },
    { id: 'bdm-tl-2', name: 'Priya Nair', type: 'TEAM_LEADER' },
    { id: 'bdm-solo-1', name: 'Kunal Patel', email: 'kunal@gazonindia.com', type: 'SOLO_BDM' },
  ];
  /** Captures what was sent to createLead so tests can assert on it. */
  createdLeads: Array<{ input: CreateLeadInput; response: CreatedLead }> = [];

  seedBdms(bdms: BdmAssignable[]): void {
    this.bdms = bdms;
  }

  async listAssignableBdms(): Promise<BdmAssignable[]> {
    return this.bdms;
  }

  async createLead(input: CreateLeadInput): Promise<CreatedLead> {
    // Honour dedupe semantics so callers can exercise the idempotent path.
    const existing = this.createdLeads.find((r) => r.input.samLeadId === input.samLeadId);
    if (existing) return { ...existing.response, deduped: true };
    const response: CreatedLead = {
      id: `crm-lead-${this.createdLeads.length + 1}`,
      leadNumber: `GAZ-${String(1000 + this.createdLeads.length).padStart(4, '0')}`,
      assignedToUserId: input.assignedTo.userId,
      assignedToName:
        this.bdms.find((b) => b.id === input.assignedTo.userId)?.name ?? 'Unknown BDM',
      createdAt: new Date().toISOString(),
    };
    this.createdLeads.push({ input, response });
    return response;
  }

  async listSamLeads(filters: {
    samCreatedById?: string;
    limit?: number;
    page?: number;
  }): Promise<ListSamLeadsResponse> {
    // Reconstruct from createdLeads + bdms. Useful for tests + local dev
    // when the CRM-side endpoint hasn't shipped yet — gives the SAM "My
    // Leads" page something to render against.
    const leads: SamSourcedLead[] = this.createdLeads
      .filter(
        (r) =>
          !filters.samCreatedById ||
          r.input.source.createdBy.id === filters.samCreatedById,
      )
      .map((r) => {
        const bdm = this.bdms.find((b) => b.id === r.input.assignedTo.userId);
        return {
          id: r.response.id,
          leadNumber: r.response.leadNumber,
          samLeadId: r.input.samLeadId,
          companyName: r.input.lead.companyName,
          contactName: r.input.lead.contactName,
          phone: r.input.lead.phone,
          email: r.input.lead.email ?? null,
          // Stub status — real CRM would return CRM-side stage enum.
          status: 'NEW',
          currentOwner: {
            id: r.input.assignedTo.userId,
            name: bdm?.name ?? 'Unknown',
            email: bdm?.email ?? null,
            type: bdm?.type ?? 'SOLO_BDM',
          },
          samCreatedById: r.input.source.createdBy.id,
          samCreatedByName: r.input.source.createdBy.name,
          samCreatedAt: r.input.source.createdAt,
          lastUpdatedAt: r.response.createdAt,
        };
      });
    const limit = filters.limit ?? 50;
    const page = filters.page ?? 1;
    const slice = leads.slice((page - 1) * limit, page * limit);
    return { leads: slice, total: leads.length, page, pageSize: limit };
  }
}
