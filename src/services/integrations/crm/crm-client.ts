import type { ContractStatus } from '@prisma/client';

export interface CrmAccount {
  externalCrmId: string;
  clientName: string;
  currentMrr: number;
  contractStatus: ContractStatus;
  onboardingDate: Date;
  modifiedAt?: Date;
}

export interface CrmClient {
  fetchAccount(externalCrmId: string): Promise<CrmAccount | null>;
  listAccountsModifiedSince(since: Date): Promise<CrmAccount[]>;
}
