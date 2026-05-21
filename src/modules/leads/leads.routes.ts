import { Router } from 'express';
import { leadsController } from './leads.controller.js';
import { requireAuth } from '../auth/auth.middleware.js';

export const leadsRouter = Router();
leadsRouter.use(requireAuth);

// Populate the dropdown on /create-lead.
leadsRouter.get('/bdms', leadsController.listBdms);

// Submit the form.
leadsRouter.post('/', leadsController.create);

// "Leads I created" history widget — raw dispatch rows.
leadsRouter.get('/dispatches', leadsController.listDispatches);

// "My Leads" page — dispatch rows joined with current CRM owner + stage.
leadsRouter.get('/my', leadsController.listMyLeads);
