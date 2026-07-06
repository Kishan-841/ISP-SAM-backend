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
  email?: string;
  /** Annual ₹ — what the platform stores after this refactor. */
  currentArc?: number;
  contractStatus?: string;
  onboardingDate?: Date;
  leadId?: string;
  externalCrmId?: string;
  currentPlan?: string;
  bandwidthMbps?: number;
  circuitId?: string;
  customerCode?: string;
  address?: string;
  /** SAM owner identifiers — resolved to a user at import time. Email is
   *  matched first (unique), then name as a fallback. */
  samEmail?: string;
  samName?: string;
  gstNumber?: string;
  contactPersonName?: string;
  industryType?: string;
  circle?: string;
  accountManager?: string;
  userName?: string;
  ipDetails?: string;
  /** Explicit OLD/NEW (→ BASE/NEW) label from the source sheet. When present
   *  it OVERRIDES the onboarding-date-derived kitty, so operators can pin the
   *  two-kitty split to their own OLD/NEW column instead of the Apr-1 rule.
   *  Parsed to BASE/NEW in parse-workbook; unrecognised labels are dropped
   *  and the date rule applies. */
  kittyType?: 'BASE' | 'NEW';
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

  // email — populated onto accounts.email so MOM-to-customer can use it.
  email: 'email',
  emailaddress: 'email',
  emailid: 'email',
  customeremail: 'email',
  contactemail: 'email',

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
  billingstartdate: 'onboardingDate',
  billingdate: 'onboardingDate',
  billingstart: 'onboardingDate',
  servicestartdate: 'onboardingDate',
  commissioningdate: 'onboardingDate',

  // leadId
  leadid: 'leadId',
  lead: 'leadId',

  // externalCrmId
  externalcrmid: 'externalCrmId',
  crmid: 'externalCrmId',
  crmcustomerid: 'externalCrmId',
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
  bw: 'bandwidthMbps',
  currentbw: 'bandwidthMbps',

  // circuitId
  circuitid: 'circuitId',
  circuit: 'circuitId',
  circuitno: 'circuitId',
  circuitnumber: 'circuitId',

  // customerCode
  customercode: 'customerCode',
  custcode: 'customerCode',
  accountcode: 'customerCode',
  code: 'customerCode',

  // address (free-form installation / service address)
  address: 'address',
  installationaddress: 'address',
  serviceaddress: 'address',
  customeraddress: 'address',
  location: 'address',
  siteaddress: 'address',
  billingaddress: 'address',

  // SAM owner — email (preferred, unique) or name (fallback)
  samemail: 'samEmail',
  assignedsamemail: 'samEmail',
  samowneremail: 'samEmail',
  owneremail: 'samEmail',
  sam: 'samName',
  samname: 'samName',
  samowner: 'samName',
  assignedsam: 'samName',
  assignedto: 'samName',
  owner: 'samName',

  // gstNumber
  gst: 'gstNumber',
  gstno: 'gstNumber',
  gstnumber: 'gstNumber',
  gstin: 'gstNumber',
  taxid: 'gstNumber',

  // contactPersonName
  contactperson: 'contactPersonName',
  contactpersonname: 'contactPersonName',
  contactname: 'contactPersonName',
  primarycontact: 'contactPersonName',
  spoc: 'contactPersonName',

  // industryType
  industry: 'industryType',
  industrytype: 'industryType',
  sector: 'industryType',
  vertical: 'industryType',
  businesstype: 'industryType',

  // circle (geographic / network zone)
  circle: 'circle',
  zone: 'circle',
  region: 'circle',
  area: 'circle',

  // accountManager (internal AM — distinct from SAM)
  accountmanager: 'accountManager',
  am: 'accountManager',
  amname: 'accountManager',
  internalam: 'accountManager',

  // userName (internal slug, e.g. "dwl_undri")
  username: 'userName',
  loginname: 'userName',
  internalcode: 'userName',
  internalslug: 'userName',

  // kittyType — explicit OLD/NEW (→ BASE/NEW) override. See parse-workbook
  // (value normalisation) + import.service validate() (fallback to date rule).
  type: 'kittyType',
  kitty: 'kittyType',
  kittytype: 'kittyType',
  customertype: 'kittyType',
  accounttype: 'kittyType',
  basenew: 'kittyType',
  oldnew: 'kittyType',
  baseornew: 'kittyType',

  // ipDetails (comma-separated free text)
  ipdetails: 'ipDetails',
  ip: 'ipDetails',
  ipaddress: 'ipDetails',
  ipaddresses: 'ipDetails',
  assignedips: 'ipDetails',
};

export function normalizeHeader(header: string): string {
  // Drop parenthesised qualifiers like "(IT)", "(Active/Inactive)" first —
  // they're usually annotations, not part of the field name. So
  // "Email ID(IT)" normalizes to "emailid" and matches the email synonym.
  // Then lowercase and strip all non-alphanumerics so spelling/punctuation
  // variations collapse to the same canonical form.
  return header
    .trim()
    .replace(/\s*\([^)]*\)/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function mapHeader(header: string): ParsedRowKey | null {
  return HEADER_SYNONYMS[normalizeHeader(header)] ?? null;
}
