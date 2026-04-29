import type { CrmClient } from './crm-client.js';
import { CrmStub } from './crm-stub.js';

export function getCrmClient(): CrmClient {
  // Phase 5 will branch on env var to return a real HTTP-backed client.
  return new CrmStub();
}

export type { CrmClient, CrmAccount } from './crm-client.js';
