import { Router } from 'express';
import { feedbackController } from './feedback.controller.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';

export const feedbackRouter = Router();

// ── Public (no auth) — the customer-facing survey ───────────────────────────
// /form is declared before /:id so it never gets swallowed by the admin route.
feedbackRouter.get('/form', feedbackController.getForm);
feedbackRouter.post('/', feedbackController.submit);

// ── Admin — Feedbacks module. ADMIN / SUPER_ADMIN_2 / SAM_HEAD only ─────────
feedbackRouter.get(
  '/',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN_2', 'SAM_HEAD'),
  feedbackController.list,
);
feedbackRouter.get(
  '/:id',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN_2', 'SAM_HEAD'),
  feedbackController.getById,
);
