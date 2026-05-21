import type { CrmClient } from './crm-client.js';
import { CrmStub } from './crm-stub.js';
import { CrmHttpClient } from './crm-http-client.js';

let cached: CrmClient | null = null;

/**
 * Resolve a `CrmClient`. When `CRM_API_BASE_URL`, `CRM_SERVICE_EMAIL` and
 * `CRM_SERVICE_PASSWORD` are all set, returns the live HTTP-backed client.
 * Otherwise (tests, local dev with no service account) returns the
 * in-memory `CrmStub`.
 *
 * Caches the instance — the JWT inside the http client is in-memory and
 * meant to be reused across calls.
 */
export function getCrmClient(): CrmClient {
  if (cached) return cached;
  const base = process.env.CRM_API_BASE_URL;
  const email = process.env.CRM_SERVICE_EMAIL;
  const password = process.env.CRM_SERVICE_PASSWORD;
  if (base && email && password) {
    cached = new CrmHttpClient(base, email, password);
  } else {
    cached = new CrmStub();
  }
  return cached;
}

/** Test-only — drops the cached instance so tests can swap implementations. */
export function resetCrmClientCacheForTests(): void {
  cached = null;
}

/** Test-only — explicitly install a stub (useful in vitest setup). */
export function setCrmClientForTests(client: CrmClient): void {
  cached = client;
}

export { CrmStub } from './crm-stub.js';
export { CrmHttpClient } from './crm-http-client.js';
export type {
  CrmClient,
  CrmAccount,
  CreateServiceOrderInput,
  ServiceOrder,
  ServiceOrderType,
  DisconnectionCategory,
  BdmAssignable,
  BdmType,
  CreateLeadInput,
  CreatedLead,
} from './crm-client.js';
export { CrmHttpError } from './crm-client.js';
