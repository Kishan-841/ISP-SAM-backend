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

// Admin-only forensic log of every webhook received.
integrationsRouter.get(
  '/events',
  requireAuth,
  requireRole('ADMIN'),
  integrationsController.listEvents,
);
