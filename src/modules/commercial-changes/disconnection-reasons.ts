import type { DisconnectionCategory } from '../../services/integrations/crm/index.js';

/**
 * SAM-owned disconnection reason taxonomy.
 *
 * Until now the form pulled reasons from the CRM, which made the dropdown
 * dependent on that bridge being reachable. SAM owns this policy: these
 * are the categories operators use to classify why a customer disconnected.
 * Stable slug IDs are used so audit trails survive a wording fix and the
 * CRM bridge can forward them as free-text references on the service order.
 *
 * Schema matches what the frontend's `DisconnectionCategory` type expects.
 * `isActive=true` everywhere — soft-deletion lives on the form, not here.
 */
/**
 * Resolves a slug ID into the human-readable category/sub-category labels.
 * Used when SAM commits a disconnection: the slug IDs are SAM-local, so we
 * can't pass them as `disconnectionCategoryId` to CRM (CRM has its own
 * taxonomy and rejects unknown IDs). Instead the CRM call embeds the
 * labels in the `notes` field as free text.
 *
 * Returns null for unknown slugs so callers can fall back to "Other".
 */
export function lookupDisconnectionLabels(
  categoryId: string | null,
  subCategoryId: string | null,
): { category: string | null; subCategory: string | null } {
  if (!categoryId) return { category: null, subCategory: null };
  const cat = DISCONNECTION_REASONS.find((c) => c.id === categoryId);
  if (!cat) return { category: null, subCategory: null };
  const sub = subCategoryId
    ? cat.subCategories.find((s) => s.id === subCategoryId)
    : undefined;
  return { category: cat.name, subCategory: sub?.name ?? null };
}

export const DISCONNECTION_REASONS: DisconnectionCategory[] = [
  {
    id: 'office-closed',
    name: 'Office Closed',
    isActive: true,
    subCategories: [{ id: 'office-closed', name: 'Office Closed', isActive: true }],
  },
  {
    id: 'project-closed',
    name: 'Project Closed',
    isActive: true,
    subCategories: [
      { id: 'project-handovered-closed', name: 'Project Handovered/Closed', isActive: true },
    ],
  },
  {
    id: 'commercial-issue',
    name: 'Commercial Issue',
    isActive: true,
    subCategories: [
      { id: 'moved-for-better-pricing', name: 'Moved for Better Pricing', isActive: true },
      { id: 'shifted-to-broadband', name: 'Shifted to Broadband', isActive: true },
      {
        id: 'company-in-crisis-business-downfall',
        name: 'Company in Crisis / Business Downfall',
        isActive: true,
      },
    ],
  },
  {
    id: 'management-call',
    name: 'Management Call',
    isActive: true,
    subCategories: [
      {
        id: 'shifted-to-telcom',
        name: 'Shifted to Telcom (TTL / Airtel / Voda)',
        isActive: true,
      },
      { id: 'wants-single-isp', name: 'Wants Single ISP', isActive: true },
      { id: 'moved-to-coworking', name: 'Moved to Coworking Location', isActive: true },
    ],
  },
  {
    id: 'service-issue',
    name: 'Service Issue',
    isActive: true,
    subCategories: [
      { id: 'frequent-link-down', name: 'Frequent Link Down Issue', isActive: true },
      { id: 'ip-blacklisting', name: 'IP Blacklisting Issue', isActive: true },
      {
        id: 'non-service-area',
        name: 'Link in Non-Service Area / Jeopardy Location',
        isActive: true,
      },
      {
        id: 'link-shifting-non-feasible',
        name: 'Link Shifting in Non-Feasible Location',
        isActive: true,
      },
      { id: 'vendor-partner-support', name: 'Vendor / Partner Support Issue', isActive: true },
    ],
  },
];
