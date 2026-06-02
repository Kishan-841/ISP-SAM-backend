import { Router } from 'express';
import multer from 'multer';
import { accountsController } from './accounts.controller.js';
import { importController } from './import/import.controller.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap
});

export const accountsRouter = Router();
accountsRouter.use(requireAuth);
accountsRouter.get('/', accountsController.list);
accountsRouter.post('/import', requireRole('ADMIN', 'SAM_HEAD'), upload.single('file'), importController.upload);
accountsRouter.get('/:id', accountsController.getById);
accountsRouter.get('/:id/journey', accountsController.journey);
accountsRouter.post(
  '/:id/assign',
  requireRole('ADMIN', 'SAM_HEAD'),
  accountsController.assign,
);
accountsRouter.patch('/:id', requireRole('ADMIN'), accountsController.update);
