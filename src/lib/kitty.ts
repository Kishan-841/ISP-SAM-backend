import type { KittyType } from '@prisma/client';

export function currentFiscalCutoff(now: Date = new Date()): Date {
  const year = now.getUTCFullYear();
  const aprilFirst = new Date(Date.UTC(year, 3, 1));
  return now >= aprilFirst ? aprilFirst : new Date(Date.UTC(year - 1, 3, 1));
}

export function deriveKittyType(onboardingDate: Date, now: Date = new Date()): KittyType {
  return onboardingDate <= currentFiscalCutoff(now) ? 'BASE' : 'NEW';
}
