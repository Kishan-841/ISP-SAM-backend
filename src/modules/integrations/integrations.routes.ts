import { Router } from 'express';
import { integrationsController } from './integrations.controller.js';
import { verifyCrmWebhook } from './crm-webhook.middleware.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';

export const integrationsRouter = Router();

// Inbound webhook — auth via HMAC, NOT JWT.
const requireCrmSignature = verifyCrmWebhook();

integrationsRouter.post(
  '/crm/customer-activated',
  requireCrmSignature,
  integrationsController.customerActivated,
);

// CRM Admin's APPROVE / REJECT decision on a SAM-raised QUICK disconnect.
// Same shared secret + signing scheme as customer.activated per contract §1.5.
// LEGACY — kept for backward compatibility with the original gate-only model.
// New CRM builds should fire commercialChange.statusChanged instead (per
// docs/integrations/quick-disconnect-end-to-end-spec.md §3.4 option A).
integrationsRouter.post(
  '/crm/quick-disconnect-decision',
  requireCrmSignature,
  integrationsController.quickDisconnectDecision,
);

// CRM service-order workflow transition (every state change). Per spec
// docs/integrations/quick-disconnect-end-to-end-spec.md §3.2.
integrationsRouter.post(
  '/crm/commercial-change-status',
  requireCrmSignature,
  integrationsController.commercialChangeStatusChanged,
);

// Single-URL dispatcher — CRM can POST any event type here and we route
// by body.eventType. Saves them from configuring a new per-event URL
// every time we add an event. Recommended SAM_WEBHOOK_URL going forward.
integrationsRouter.post(
  '/crm/event',
  requireCrmSignature,
  integrationsController.dispatch,
);

// Admin-only forensic log of every webhook received.
integrationsRouter.get(
  '/events',
  requireAuth,
  requireRole('ADMIN'),
  integrationsController.listEvents,
);

// Admin-only: list commercial-change rows where the outbound CRM call
// failed. Surfaces "SAM committed but CRM didn't take" cases that today
// only show as console.warn lines + crmError in the RETENTION_PROCEEDED
// audit payload.
integrationsRouter.get(
  '/outbound-failures',
  requireAuth,
  requireRole('ADMIN'),
  integrationsController.listOutboundFailures,
);

/**
 * Alias router mounted at /webhooks. Exists so the CRM team can configure
 * SAM_WEBHOOK_URL with the contract's suggested path
 * (/webhooks/crm/quick-disconnect.decided) without needing to know our
 * internal /integrations layout. Same handler as the SAM-native route.
 */
export const crmWebhookAliasRouter = Router();
crmWebhookAliasRouter.post(
  '/crm/quick-disconnect.decided',
  requireCrmSignature,
  integrationsController.quickDisconnectDecision,
);
crmWebhookAliasRouter.post(
  '/crm/commercial-change.status-changed',
  requireCrmSignature,
  integrationsController.commercialChangeStatusChanged,
);
// Single-URL dispatcher alias (matches the contract path convention).
crmWebhookAliasRouter.post(
  '/crm/event',
  requireCrmSignature,
  integrationsController.dispatch,
);
