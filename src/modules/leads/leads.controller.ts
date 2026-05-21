import type { Response } from 'express';
import { z } from 'zod';
import { leadsService } from './leads.service.js';
import type { AuthedRequest } from '../auth/auth.middleware.js';
import { prisma } from '../../prisma.js';

const phoneRegex = /^[0-9]{10}$/;

const createLeadSchema = z.object({
  companyName: z.string().trim().min(2, 'Company name must be at least 2 chars'),
  contactName: z.string().trim().min(2, 'Contact name must be at least 2 chars'),
  // Phone — operator may type spaces / dashes / a +91 prefix. Strip and validate.
  phone: z
    .string()
    .transform((s) => s.replace(/[^0-9]/g, '').replace(/^91/, ''))
    .refine((s) => phoneRegex.test(s), 'Phone must be a 10-digit Indian mobile number'),
  email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
  designation: z.string().trim().max(100).optional().or(z.literal('').transform(() => undefined)),
  industry: z.string().trim().max(100).optional().or(z.literal('').transform(() => undefined)),
  city: z.string().trim().max(100).optional().or(z.literal('').transform(() => undefined)),
  notes: z.string().trim().max(2000).optional().or(z.literal('').transform(() => undefined)),
  assignedToUserId: z.string().min(1, 'Pick a BDM to assign the lead to'),
});

function requireUser(req: AuthedRequest, res: Response): { id: string; role: 'ADMIN' | 'SAM_HEAD' | 'SAM' } | null {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthenticated' });
    return null;
  }
  return req.user as { id: string; role: 'ADMIN' | 'SAM_HEAD' | 'SAM' };
}

export const leadsController = {
  /**
   * GET /leads/bdms — populates the assignment dropdown. Fetches fresh from
   * CRM so BDM team changes show up immediately.
   */
  async listBdms(req: AuthedRequest, res: Response) {
    if (!requireUser(req, res)) return;
    try {
      const bdms = await leadsService.listBdms();
      res.json({ bdms });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'CRM call failed';
      res.status(502).json({
        error: 'BDM_LIST_UNAVAILABLE',
        detail: message,
      });
    }
  },

  /**
   * POST /leads — validate the form, look up the selected BDM's display
   * name (for our dispatch row + CRM audit), forward to CRM, return the
   * outcome.
   */
  async create(req: AuthedRequest, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;

    const parse = createLeadSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        error: 'VALIDATION_FAILED',
        detail: parse.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      });
      return;
    }

    // Resolve assignedTo name + type by re-fetching the BDM list. Avoids
    // trusting the client to send a label that matches the id.
    let assignedToName: string;
    let assignedToType: 'TEAM_LEADER' | 'SOLO_BDM';
    try {
      const bdms = await leadsService.listBdms();
      const match = bdms.find((b) => b.id === parse.data.assignedToUserId);
      if (!match) {
        res.status(404).json({
          error: 'BDM_NOT_FOUND',
          detail:
            'The selected BDM is no longer assignable. Reload the dropdown and pick another.',
        });
        return;
      }
      assignedToName = match.name;
      assignedToType = match.type;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'CRM call failed';
      res.status(502).json({ error: 'BDM_LIST_UNAVAILABLE', detail: message });
      return;
    }

    // Operator details for source.createdBy — pull name/email from the User row.
    const operator = await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, name: true, email: true },
    });
    if (!operator) {
      res.status(401).json({ error: 'Authenticated user not found' });
      return;
    }

    try {
      const result = await leadsService.commit({
        ...parse.data,
        assignedToName,
        assignedToType,
        performedBy: operator,
      });
      if (result.status === 'FAILED') {
        // CRM rejected — give back 502 so the frontend surfaces a "CRM
        // rejected" toast rather than treating the lead as created.
        res.status(502).json({
          error: 'CRM_REJECTED',
          detail: result.errorReason ?? 'Unknown CRM error',
          dispatchId: result.dispatchId,
        });
        return;
      }
      res.status(201).json({
        status: result.status,
        dispatchId: result.dispatchId,
        samLeadId: result.samLeadId,
        crmLeadId: result.crmLeadId,
        crmLeadNumber: result.crmLeadNumber,
        assignedToName,
      });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('LEAD_DISPATCH_DISABLED:')) {
        res.status(422).json({ error: 'LEAD_DISPATCH_DISABLED', detail: err.message });
        return;
      }
      throw err;
    }
  },

  /**
   * GET /leads/dispatches — the "Leads I created" history view. SAM sees
   * their own; SAM_HEAD / ADMIN see everyone's. Raw dispatch rows; no
   * CRM enrichment.
   */
  async listDispatches(req: AuthedRequest, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
    const dispatches = await leadsService.listDispatches({
      requester: user,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    res.json({ dispatches });
  },

  /**
   * GET /leads/my — the "My Leads" page data. Local dispatch rows joined
   * with current CRM owner + stage. Used by the SAM frontend's history
   * view. Same role scoping as listDispatches.
   */
  async listMyLeads(req: AuthedRequest, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
    const result = await leadsService.listWithLiveStatus({
      requester: user,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    res.json(result);
  },
};
