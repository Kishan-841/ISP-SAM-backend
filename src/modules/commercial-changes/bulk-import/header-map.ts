/**
 * Canonical column names for the bulk commercial-change Excel. Headers match
 * loosely — case, spaces, and underscores are ignored so any reasonable
 * variant of the column name resolves to the same canonical key.
 */
export type CanonicalRow = {
  circuitId?: string;
  changeType?: string;
  newArc?: number | null;
  newBandwidthMbps?: number | null;
  effectiveDate?: Date | null;
  mailReceivedDate?: Date | null;
  disconnectionReason?: string | null;
  reason?: string | null;
};

const ALIASES: Record<string, keyof CanonicalRow> = {
  // Circuit ID — unique key per row. We deliberately don't allow client_name
  // here because Indian customer names regularly have duplicates and casing
  // drift (see the Suchitra/suchitra incident).
  circuitid: 'circuitId',
  circuit: 'circuitId',
  circuitno: 'circuitId',
  circuitnumber: 'circuitId',

  changetype: 'changeType',
  type: 'changeType',
  action: 'changeType',

  // New target ARC. Old ARC is read live from the DB so the spreadsheet can't
  // accidentally race against another change.
  newarc: 'newArc',
  arc: 'newArc',
  newannualarc: 'newArc',

  newbandwidth: 'newBandwidthMbps',
  newbandwidthmbps: 'newBandwidthMbps',
  bandwidth: 'newBandwidthMbps',
  bw: 'newBandwidthMbps',

  effectivedate: 'effectiveDate',
  date: 'effectiveDate',

  mailreceiveddate: 'mailReceivedDate',
  approvaldate: 'mailReceivedDate',
  mailreceived: 'mailReceivedDate',

  disconnectionreason: 'disconnectionReason',
  disconreason: 'disconnectionReason',
  terminationreason: 'disconnectionReason',

  reason: 'reason',
  notes: 'reason',
  remarks: 'reason',
};

export function mapHeader(header: string): keyof CanonicalRow | null {
  const key = header.toLowerCase().replace(/[\s_/-]/g, '');
  return ALIASES[key] ?? null;
}
