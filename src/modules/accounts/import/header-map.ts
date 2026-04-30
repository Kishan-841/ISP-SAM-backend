// Canonical Account fields the import understands.
// Each entry maps a normalized header (lowercased, stripped of underscores
// and non-alphanumeric chars) to the canonical Prisma field name.
//
// All other columns get serialised under `metadata` keyed by the original
// (verbatim) header.

export type CanonicalRow = {
  clientName?: string;
  companyName?: string;
  mobileNumber?: string;
  currentMrr?: number;
  currentArc?: number;
  contractStatus?: string;
  onboardingDate?: Date;
  leadId?: string;
  externalCrmId?: string;
  currentPlan?: string;
};

export const HEADER_SYNONYMS: Record<string, keyof CanonicalRow> = {
  // clientName
  clientname: 'clientName',
  customername: 'clientName',
  name: 'clientName',
  client: 'clientName',
  customer: 'clientName',

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

  // currentMrr (monthly)
  mrr: 'currentMrr',
  monthlymrr: 'currentMrr',
  currentmrr: 'currentMrr',
  monthlyrevenue: 'currentMrr',

  // currentArc (annualized)  — converted to currentMrr (÷ 12) by parser
  arc: 'currentArc',
  currentarc: 'currentArc',
  annualrevenue: 'currentArc',
  annualizedrevenue: 'currentArc',

  // contractStatus
  status: 'contractStatus',
  contractstatus: 'contractStatus',

  // onboardingDate
  onboardingdate: 'onboardingDate',
  startdate: 'onboardingDate',
  joineddate: 'onboardingDate',
  since: 'onboardingDate',

  // leadId
  leadid: 'leadId',
  lead: 'leadId',

  // externalCrmId
  externalcrmid: 'externalCrmId',
  crmid: 'externalCrmId',
  customerid: 'externalCrmId',

  // currentPlan
  currentplan: 'currentPlan',
  plan: 'currentPlan',
  package: 'currentPlan',
  bandwidth: 'currentPlan',
};

export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ''); // strip spaces, underscores, dashes, parens, etc.
}

export function mapHeader(header: string): keyof CanonicalRow | null {
  return HEADER_SYNONYMS[normalizeHeader(header)] ?? null;
}
