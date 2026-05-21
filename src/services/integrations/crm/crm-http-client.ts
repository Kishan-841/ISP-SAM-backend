import {
  type CrmClient,
  type CrmAccount,
  type CreateServiceOrderInput,
  type ServiceOrder,
  type DisconnectionCategory,
  type BdmAssignable,
  type CreateLeadInput,
  type CreatedLead,
  CrmHttpError,
} from './crm-client.js';

/**
 * Real HTTP-backed implementation of `CrmClient` against the CRM's REST API.
 *
 * Auth model — staff JWT, NOT HMAC.
 *   1. Login once with service-account email + password → get `token`.
 *   2. Cache the token in-memory and refresh proactively when it's close to
 *      expiry (CRM tokens last 7 days; we refresh after 6).
 *   3. Per CRM team's spec, do NOT do `request → 401 → re-auth → retry`.
 *      A 401 means our cached token genuinely went bad and a request after
 *      that should fail loudly so we notice and investigate.
 */
export class CrmHttpClient implements CrmClient {
  private jwt: string | null = null;
  private jwtFetchedAt: number | null = null;
  private readonly REFRESH_AFTER_MS = 6 * 24 * 60 * 60 * 1000; // 6 days

  constructor(
    private readonly baseUrl: string,
    private readonly serviceEmail: string,
    private readonly servicePassword: string,
  ) {}

  // Service orders are the only methods we actually use for now. The
  // CrmAccount methods exist on the interface for the original
  // customer.activated bridge — when running the HTTP client they're
  // no-ops; the customer-side bridge runs CRM→SAM, not SAM→CRM.

  async fetchAccount(_externalCrmId: string): Promise<CrmAccount | null> {
    return null;
  }

  async listAccountsModifiedSince(_since: Date): Promise<CrmAccount[]> {
    return [];
  }

  async createServiceOrder(input: CreateServiceOrderInput): Promise<ServiceOrder> {
    const body = await this.request<{ message: string; data: ServiceOrder }>(
      'POST',
      '/service-orders',
      input,
    );
    return body.data;
  }

  async listServiceOrders(filters: { customerId: string }): Promise<ServiceOrder[]> {
    const qs = `?customerId=${encodeURIComponent(filters.customerId)}`;
    const body = await this.request<unknown>('GET', `/service-orders${qs}`);
    return extractArray<ServiceOrder>(body, ['orders', 'serviceOrders', 'data', 'items']);
  }

  async setActivationDate(orderId: string, activationDate: Date): Promise<ServiceOrder> {
    const body = await this.request<{ data: ServiceOrder }>(
      'POST',
      `/service-orders/${orderId}/set-activation-date`,
      { activationDate: activationDate.toISOString() },
    );
    return body.data;
  }

  async fetchDisconnectionReasons(): Promise<DisconnectionCategory[]> {
    const body = await this.request<unknown>('GET', '/service-orders/disconnection-reasons');
    return extractArray<DisconnectionCategory>(body, [
      'reasons',
      'categories',
      'data',
      'items',
    ]);
  }

  async listAssignableBdms(): Promise<BdmAssignable[]> {
    const body = await this.request<unknown>('GET', '/integrations/sam/bdms');
    return extractArray<BdmAssignable>(body, ['bdms', 'data', 'items']);
  }

  async createLead(input: CreateLeadInput): Promise<CreatedLead> {
    // CRM may return either 201 (created) or 200 (idempotent replay with
    // `deduped: true`). Both shapes carry the lead under `lead`. The HTTP
    // request helper throws on non-2xx so by the time we get here it's
    // one of those two; we don't need to branch.
    const body = await this.request<{
      lead: CreatedLead;
      samLeadId?: string;
      deduped?: boolean;
    }>('POST', '/integrations/sam/leads', input);
    return { ...body.lead, deduped: body.deduped === true };
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private async getJwt(): Promise<string> {
    const cacheStillFresh =
      this.jwt !== null &&
      this.jwtFetchedAt !== null &&
      Date.now() - this.jwtFetchedAt < this.REFRESH_AFTER_MS;
    if (cacheStillFresh && this.jwt) return this.jwt;
    return this.refreshJwt();
  }

  /** Force a JWT refresh. Called from getJwt() when the cache is stale. */
  private async refreshJwt(): Promise<string> {
    const path = '/auth/login';
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.serviceEmail, password: this.servicePassword }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new CrmHttpError(res.status, parseJson(text), path);
    }
    const body = parseJson(text) as { token?: string; data?: { token?: string } };
    const token = body.token ?? body.data?.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new CrmHttpError(
        500,
        { message: 'Login response did not contain a token' },
        path,
      );
    }
    this.jwt = token;
    this.jwtFetchedAt = Date.now();
    return token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const jwt = await this.getJwt();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed = parseJson(text);
    if (!res.ok) throw new CrmHttpError(res.status, parsed, path);
    return parsed as T;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/**
 * Pull the first array out of a CRM response, regardless of the wrapper key.
 * CRM endpoints inconsistently use `{ orders: [] }`, `{ data: [] }`,
 * `{ reasons: [] }`, `{ items: [] }`, etc. Trying common keys keeps us
 * working without forcing the CRM team to settle on one envelope.
 *
 * Returns [] (and logs once) for any unrecognised shape so callers can
 * keep going instead of throwing — the empty result will surface in the
 * UI as "no rows" which is harmless and obvious.
 */
function extractArray<T>(body: unknown, keys: string[]): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    for (const key of keys) {
      const v = obj[key];
      if (Array.isArray(v)) return v as T[];
    }
    // Sometimes CRM nests one level deeper, e.g. { data: { orders: [...] } }.
    if (obj.data && typeof obj.data === 'object') {
      const inner = obj.data as Record<string, unknown>;
      for (const key of keys) {
        const v = inner[key];
        if (Array.isArray(v)) return v as T[];
      }
    }
  }
  console.warn(
    '[CrmHttpClient] could not find an array in response; tried keys:',
    keys,
    'body:',
    body,
  );
  return [];
}
