import { describe, it, expect } from 'vitest';
import { CrmStub } from '../src/services/integrations/crm/crm-stub.js';

describe('CrmStub', () => {
  it('returns null when account is not seeded', async () => {
    const crm = new CrmStub();
    expect(await crm.fetchAccount('non-existent-id')).toBeNull();
  });

  it('returns a seeded account by externalCrmId', async () => {
    const crm = new CrmStub();
    crm.seed({
      externalCrmId: 'CRM-123',
      clientName: 'Acme Corp',
      currentMrr: 50000,
      contractStatus: 'ACTIVE',
      onboardingDate: new Date('2025-01-15'),
    });
    const got = await crm.fetchAccount('CRM-123');
    expect(got?.clientName).toBe('Acme Corp');
    expect(got?.currentMrr).toBe(50000);
  });

  it('listAccountsModifiedSince returns only accounts with mtime >= cutoff', async () => {
    const crm = new CrmStub();
    crm.seed({ externalCrmId: 'OLD', clientName: 'Old', currentMrr: 1000, contractStatus: 'ACTIVE', onboardingDate: new Date('2024-01-01'), modifiedAt: new Date('2026-01-01') });
    crm.seed({ externalCrmId: 'NEW', clientName: 'New', currentMrr: 2000, contractStatus: 'ACTIVE', onboardingDate: new Date('2026-04-15'), modifiedAt: new Date('2026-04-20') });
    const recent = await crm.listAccountsModifiedSince(new Date('2026-04-01'));
    expect(recent.map(a => a.externalCrmId)).toEqual(['NEW']);
  });
});
