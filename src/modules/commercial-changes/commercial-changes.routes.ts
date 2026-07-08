import { Router } from 'express';
import multer from 'multer';
import { commercialChangesController } from './commercial-changes.controller.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';

// Attachments — any file format up to 10 MB. We deliberately do not
// allow-list extensions: SAMs receive customer approvals as emails,
// PDFs, Word docs, screenshots, scans, and the occasional spreadsheet
// or zip. Files are stored in Cloudinary and served back through the
// auth-gated /commercial-changes/:id/file proxy, so the XSS / script
// surface is contained even for HTML-ish uploads. The 10 MB cap stays
// to keep Cloudinary egress + memory usage bounded.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
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

// ADMIN-only bulk-import: one Excel file → many commercial changes. No
// CRM round-trip, no document gate (matches backfill-disconnection
// semantics). Multipart field name: `file`. Same 10 MB size cap as the
// per-row commit.
commercialChangesRouter.post(
  '/bulk-import',
  requireRole('ADMIN'),
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        res.status(422).json({ error: err.message });
        return;
      }
      next();
    });
  },
  commercialChangesController.bulkImport,
);

// Queue + decision for BASE-kitty quick-disconnect approvals that stay
// entirely in SAM (no CRM round-trip). NEW kitty still routes to CRM
// admin, unchanged. ADMIN sees the whole queue; SAM_HEAD sees only their
// own + their team's requests (scoped in the service layer).
commercialChangesRouter.get(
  '/quick-approvals',
  requireRole('ADMIN', 'SAM_HEAD'),
  commercialChangesController.listQuickApprovals,
);
commercialChangesRouter.post(
  '/:id/sam-quick-decision',
  requireRole('ADMIN', 'SAM_HEAD'),
  commercialChangesController.samQuickDecision,
);

// Internal approval chain for BASE (existing-base) commercial changes. The
// queue shows each approver only the stage they own; the service enforces the
// per-stage role + team scope. Mounted BEFORE `/:id/...` so the static path
// isn't captured as an id.
commercialChangesRouter.get(
  '/approvals',
  requireRole('ADMIN', 'SUPER_ADMIN_2', 'SAM_HEAD', 'ACCOUNTS'),
  commercialChangesController.listApprovals,
);
commercialChangesRouter.post(
  '/:id/approval-decision',
  requireRole('ADMIN', 'SUPER_ADMIN_2', 'SAM_HEAD', 'ACCOUNTS'),
  commercialChangesController.approvalDecision,
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

// Auth-gated file proxy. Resolves the right Cloudinary URL after a
// role-scoped access check and 302-redirects. Audits the download.
commercialChangesRouter.get('/:id/file/:kind', commercialChangesController.file);

commercialChangesRouter.post('/:id/refresh-status', commercialChangesController.refreshCrmStatus);
commercialChangesRouter.post(
  '/:id/set-activation-date',
  commercialChangesController.setActivationDate,
);
commercialChangesRouter.post(
  '/:id/retention-decision',
  commercialChangesController.retentionDecision,
);
