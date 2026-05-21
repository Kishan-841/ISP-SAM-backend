import { Router } from 'express';
import { leadsController } from './leads.controller.js';
import { requireAuth } from '../auth/auth.middleware.js';

export const leadsRouter = Router();
leadsRouter.use(requireAuth);

// Populate the dropdown on /create-lead.
leadsRouter.get('/bdms', leadsController.listBdms);

// Submit the form.
leadsRouter.post('/', leadsController.create);

// "Leads I created" history widget.
leadsRouter.get('/dispatches', leadsController.listDispatches);
