import { Router } from 'express';
import multer from 'multer';
import { commercialChangesController } from './commercial-changes.controller.js';
import { requireAuth } from '../auth/auth.middleware.js';

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
