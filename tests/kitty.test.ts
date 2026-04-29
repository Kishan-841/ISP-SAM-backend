import { describe, it, expect } from 'vitest';
import { deriveKittyType, currentFiscalCutoff } from '../src/lib/kitty.js';

describe('deriveKittyType', () => {
  it('returns BASE when onboarding is exactly Apr 1 of current FY', () => {
    expect(deriveKittyType(new Date('2026-04-01'), new Date('2026-06-15'))).toBe('BASE');
  });

  it('returns BASE when onboarding is before Apr 1 of current FY', () => {
    expect(deriveKittyType(new Date('2025-12-31'), new Date('2026-06-15'))).toBe('BASE');
  });

  it('returns NEW when onboarding is after Apr 1 of current FY', () => {
    expect(deriveKittyType(new Date('2026-04-02'), new Date('2026-06-15'))).toBe('NEW');
  });

  it('rolls over: an account onboarded last May is BASE in next FY', () => {
    // "Now" is past Apr 1 2027 → cutoff is Apr 1 2027 → May 2026 onboarding is BASE
    expect(deriveKittyType(new Date('2026-05-01'), new Date('2027-06-15'))).toBe('BASE');
  });

  it('returns NEW when onboarding is one millisecond after the Apr 1 cutoff', () => {
    expect(deriveKittyType(new Date('2026-04-01T00:00:00.001Z'), new Date('2026-06-15'))).toBe('NEW');
  });

  it('returns NEW when onboarding is in the future relative to "now"', () => {
    expect(deriveKittyType(new Date('2027-01-01'), new Date('2026-06-15'))).toBe('NEW');
  });
});

describe('currentFiscalCutoff', () => {
  it('returns Apr 1 of current calendar year when "now" is on or after Apr 1', () => {
    expect(currentFiscalCutoff(new Date('2026-06-15'))).toEqual(new Date('2026-04-01'));
  });

  it('returns Apr 1 of previous calendar year when "now" is before Apr 1', () => {
    expect(currentFiscalCutoff(new Date('2026-02-15'))).toEqual(new Date('2025-04-01'));
  });

  it('returns Apr 1 00:00 UTC when "now" is Apr 1 00:00 UTC exactly', () => {
    const aprFirst = new Date('2026-04-01T00:00:00Z');
    expect(currentFiscalCutoff(aprFirst)).toEqual(aprFirst);
  });
});
