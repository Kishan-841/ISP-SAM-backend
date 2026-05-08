// Canonical Account fields the import understands.
// Each entry maps a normalized header (lowercased, stripped of underscores
// and non-alphanumeric chars) to the canonical Prisma field name.
//
// All other columns get serialised under `metadata` keyed by the original
// (verbatim) header.
//
// IMPORTANT: amounts are now ANNUAL ARC. Legacy "MRR"-named headers are still
// accepted as a backwards-compat seam — the parser multiplies them by 12 so
// the stored value is annual regardless of the source header.

export type CanonicalRow = {
  clientName?: string;
  companyName?: string;
  mobileNumber?: string;
  /** Annual ₹ — what the platform stores after this refactor. */
  currentArc?: number;
  contractStatus?: string;
  onboardingDate?: Date;
  leadId?: string;
  externalCrmId?: string;
  currentPlan?: string;
  bandwidthMbps?: number;
};

/**
 * Internal-only marker used by the parser. Headers labelled "MRR" map here
 * and the parser multiplies them by 12 before populating `currentArc`.
 */
export type ParsedRowKey = keyof CanonicalRow | '__monthlyMrrLegacy';

export const HEADER_SYNONYMS: Record<string, ParsedRowKey> = {
  // clientName
  clientname: 'clientName',
  customername: 'clientName',
  name: 'clientName',
  client: 'clientName',
  customer: 'clientName',
  subscribername: 'clientName',
  subscriber: 'clientName',

  // companyName
  companyname: 'companyName',
  company: 'companyName',
  organization: 'companyName',
  org: 'companyName',

  // mobileNumber
  mobilenumber: 'mobileNumber',
  mobile: 'mobileNumber',
  phone: 'mobileNumber',
  contact: 'mobileNumber',
  contactnumber: 'mobileNumber',
  phonenumber: 'mobileNumber',

  // currentArc (annualised) — canonical
  arc: 'currentArc',
  currentarc: 'currentArc',
  annualrevenue: 'currentArc',
  annualizedrevenue: 'currentArc',

  // Legacy monthly MRR headers — multiplied × 12 at parse time so the
  // stored value is always annual. Kept so old workbooks still import.
  mrr: '__monthlyMrrLegacy',
  monthlymrr: '__monthlyMrrLegacy',
  currentmrr: '__monthlyMrrLegacy',
  monthlyrevenue: '__monthlyMrrLegacy',
  monthlybill: '__monthlyMrrLegacy',
  planprice: '__monthlyMrrLegacy',
  subscriptionfee: '__monthlyMrrLegacy',
  monthlycharge: '__monthlyMrrLegacy',
  monthlyplan: '__monthlyMrrLegacy',
  tariff: '__monthlyMrrLegacy',

  // contractStatus
  status: 'contractStatus',
  contractstatus: 'contractStatus',
  connectionstatus: 'contractStatus',
  subscriptionstatus: 'contractStatus',

  // onboardingDate
  onboardingdate: 'onboardingDate',
  startdate: 'onboardingDate',
  joineddate: 'onboardingDate',
  since: 'onboardingDate',
  installationdate: 'onboardingDate',
  activationdate: 'onboardingDate',

  // leadId
  leadid: 'leadId',
  lead: 'leadId',

  // externalCrmId
  externalcrmid: 'externalCrmId',
  crmid: 'externalCrmId',
  customerid: 'externalCrmId',
  subscriberid: 'externalCrmId',
  connectionid: 'externalCrmId',
  accountid: 'externalCrmId',

  // currentPlan
  currentplan: 'currentPlan',
  plan: 'currentPlan',
  package: 'currentPlan',

  // bandwidthMbps
  bandwidth: 'bandwidthMbps',
  mbps: 'bandwidthMbps',
  speed: 'bandwidthMbps',
  bandwidthmbps: 'bandwidthMbps',
};

export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ''); // strip spaces, underscores, dashes, parens, etc.
}

export function mapHeader(header: string): ParsedRowKey | null {
  return HEADER_SYNONYMS[normalizeHeader(header)] ?? null;
}
