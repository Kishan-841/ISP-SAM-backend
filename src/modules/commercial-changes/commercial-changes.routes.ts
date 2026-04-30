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
    else cb(new Error('Approval must be .eml, .msg or .pdf'));
  },
});

export const commercialChangesRouter = Router();
commercialChangesRouter.use(requireAuth);

commercialChangesRouter.get('/', commercialChangesController.list);

commercialChangesRouter.post(
  '/',
  // Multer error → translate into 422 (matches the hard-gate semantics)
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        res.status(422).json({ error: err.message });
        return;
      }
      next();
    });
  },
  commercialChangesController.commit,
);
