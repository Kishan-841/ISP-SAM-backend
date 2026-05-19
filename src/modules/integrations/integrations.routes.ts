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
integrationsRouter.post(
  '/crm/quick-disconnect-decision',
  requireCrmSignature,
  integrationsController.quickDisconnectDecision,
);

// Admin-only forensic log of every webhook received.
integrationsRouter.get(
  '/events',
  requireAuth,
  requireRole('ADMIN'),
  integrationsController.listEvents,
);
