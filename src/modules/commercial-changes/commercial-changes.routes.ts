import { Router } from 'express';
import multer from 'multer';
import { commercialChangesController } from './commercial-changes.controller.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.eml', '.msg', '.pdf'];
    const ext = (file.originalname.match(/\.[^.]+$/) ?? [''])[0].toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Attachments must be .eml, .msg or .pdf'));
  },
});

export const commercialChangesRouter = Router();
commercialChangesRouter.use(requireAuth);

commercialChangesRouter.get('/', commercialChangesController.list);
commercialChangesRouter.get(
  '/disconnection-reasons',
  commercialChangesController.disconnectionReasons,
);

// ADMIN-only backfill for historical disconnections — no CRM round-trip,
// no approval queue. Mounted BEFORE `/:id/...` routes so the static
// path doesn't get captured as an id.
commercialChangesRouter.post(
  '/backfill-disconnection',
  requireRole('ADMIN'),
  commercialChangesController.backfillDisconnection,
);

// ADMIN-only queue + decision for BASE-kitty quick-disconnect approvals
// that stay entirely in SAM (no CRM round-trip). NEW kitty still routes
// to CRM admin, unchanged.
commercialChangesRouter.get(
  '/quick-approvals',
  requireRole('ADMIN'),
  commercialChangesController.listQuickApprovals,
);
commercialChangesRouter.post(
  '/:id/sam-quick-decision',
  requireRole('ADMIN'),
  commercialChangesController.samQuickDecision,
);

commercialChangesRouter.post(
  '/',
  // Multer error → translate into 422 (matches the hard-gate semantics).
  // Two named files: approvalFile (client approval) + poFile (Purchase Order).
  (req, res, next) => {
    upload.fields([
      { name: 'approvalFile', maxCount: 1 },
      { name: 'poFile', maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        res.status(422).json({ error: err.message });
        return;
      }
      next();
    });
  },
  commercialChangesController.commit,
);

commercialChangesRouter.post('/:id/refresh-status', commercialChangesController.refreshCrmStatus);
commercialChangesRouter.post(
  '/:id/set-activation-date',
  commercialChangesController.setActivationDate,
);
commercialChangesRouter.post(
  '/:id/retention-decision',
  commercialChangesController.retentionDecision,
);
