/**
 * Two-Kitty model: classify accounts as BASE (existing portfolio) or NEW
 * (added this fiscal year), per CLAUDE.md §1.
 *
 * Indian fiscal year runs April 1 → March 31. India does not observe DST.
 *
 * **Input contract:** callers MUST pass date-only `Date` instances — i.e.
 * `new Date('YYYY-MM-DD')` which the JS engine constructs as UTC midnight.
 * Passing a `Date` constructed from a local-time-only ISO string (e.g.
 * `new Date('2026-04-01T00:00:00')` without a `Z` or offset) will produce
 * inconsistent results across host timezones. The Phase 2 input layer (Zod)
 * is responsible for canonicalising request payloads to this format before
 * calling these functions.
 */

import type { KittyType } from '@prisma/client';

export function currentFiscalCutoff(now: Date = new Date()): Date {
  const year = now.getUTCFullYear();
  const aprilFirst = new Date(Date.UTC(year, 3, 1));
  return now >= aprilFirst ? aprilFirst : new Date(Date.UTC(year - 1, 3, 1));
}

export function deriveKittyType(onboardingDate: Date, now: Date = new Date()): KittyType {
  return onboardingDate <= currentFiscalCutoff(now) ? 'BASE' : 'NEW';
}
