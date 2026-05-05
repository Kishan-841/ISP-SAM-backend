import {
  type CrmClient,
  type CrmAccount,
  type CreateServiceOrderInput,
  type ServiceOrder,
  type DisconnectionCategory,
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
}
