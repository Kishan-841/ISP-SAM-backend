import { Router } from 'express';
import multer from 'multer';
import { accountsController } from './accounts.controller.js';
import { importController } from './import/import.controller.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';

// Excel-import uploader. Extension allowlist + 10 MB cap. The xlsx
// library (used downstream in parseWorkbook) is happy to attempt to parse
// arbitrary input — but giving it an unbounded firehose of unknown file
// types is an unnecessary attack surface. Restrict to the three
// spreadsheet formats SAM actually expects.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap
  fileFilter: (_req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv'];
    const ext = (file.originalname.match(/\.[^.]+$/) ?? [''])[0].toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Import accepts only ${allowed.join(', ')} files (got "${ext || file.originalname}")`));
    }
  },
});

export const accountsRouter = Router();
accountsRouter.use(requireAuth);
accountsRouter.get('/', accountsController.list);
// Translate multer rejection (bad extension / oversize) to a 422 with a
// friendly message — the form surfaces that as an inline error so the
// user knows immediately what went wrong.
accountsRouter.post(
  '/import',
  requireRole('ADMIN', 'SAM_HEAD'),
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        res.status(422).json({ error: err.message });
        return;
      }
      next();
    });
  },
  importController.upload,
);
accountsRouter.get('/:id', accountsController.getById);
accountsRouter.get('/:id/journey', accountsController.journey);
accountsRouter.post(
  '/:id/assign',
  requireRole('ADMIN', 'SAM_HEAD'),
  accountsController.assign,
);
accountsRouter.patch('/:id', requireRole('ADMIN'), accountsController.update);
