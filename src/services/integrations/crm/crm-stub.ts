import type { CrmClient, CrmAccount } from './crm-client.js';

export class CrmStub implements CrmClient {
  private store = new Map<string, CrmAccount>();

  seed(account: CrmAccount): void {
    this.store.set(account.externalCrmId, account);
  }

  async fetchAccount(externalCrmId: string): Promise<CrmAccount | null> {
    return this.store.get(externalCrmId) ?? null;
  }

  async listAccountsModifiedSince(since: Date): Promise<CrmAccount[]> {
    return Array.from(this.store.values()).filter(
      a => a.modifiedAt !== undefined && a.modifiedAt >= since,
    );
  }
}
