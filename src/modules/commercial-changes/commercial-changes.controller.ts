import type { Response } from 'express';
import { z } from 'zod';
import type { CommercialChangeType } from '@prisma/client';
import { commercialChangesService } from './commercial-changes.service.js';
import { getCrmClient } from '../../services/integrations/crm/index.js';
import type { AuthedRequest } from '../auth/auth.middleware.js';

const bodySchema = z.object({
  accountId: z.string().uuid(),
  changeType: z.enum(['UPGRADE', 'DOWNGRADE', 'RATE_REVISION', 'DISCONNECTION']),
  newMrr: z.coerce.number().nonnegative(),
  newBandwidthMbps: z.coerce.number().int().nonnegative().optional(),
  effectiveDate: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date'),
  reason: z.string().optional(),
  // Disconnection-only — required server-side when changeType=DISCONNECTION.
  disconnectionCategoryId: z.string().optional(),
  disconnectionSubCategoryId: z.string().optional(),
  disconnectionReason: z.string().optional(),
  notes: z.string().optional(),
});

const setActivationDateSchema = z.object({
  activationDate: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date'),
});

export const commercialChangesController = {
  async commit(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }

    // multer.fields() puts uploaded files under req.files keyed by field name.
    type UploadedFile = { buffer: Buffer; originalname?: string };
    const files = (
      req as AuthedRequest & { files?: Record<string, UploadedFile[] | undefined> }
    ).files;
    const approvalFile = files?.approvalFile?.[0];
    const poFile = files?.poFile?.[0];
    if (!approvalFile) {
      res.status(422).json({ error: 'Client approval email is mandatory' });
      return;
    }
    if (!poFile) {
      res.status(422).json({ error: 'Purchase Order (PO) is mandatory' });
      return;
    }

    const parse = bodySchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }

    if (
      parse.data.changeType === 'DISCONNECTION' &&
      (!parse.data.disconnectionCategoryId || !parse.data.disconnectionSubCategoryId)
    ) {
      res.status(400).json({
        error: 'disconnectionCategoryId and disconnectionSubCategoryId are required for DISCONNECTION',
      });
      return;
    }

    try {
      const result = await commercialChangesService.commit({
        accountId: parse.data.accountId,
        changeType: parse.data.changeType,
        newMrr: parse.data.newMrr,
        newBandwidthMbps: parse.data.newBandwidthMbps ?? null,
        effectiveDate: new Date(parse.data.effectiveDate),
        reason: parse.data.reason ?? null,
        approvalFile: {
          buffer: approvalFile.buffer,
          originalName: approvalFile.originalname ?? 'approval',
        },
        poFile: {
          buffer: poFile.buffer,
          originalName: poFile.originalname ?? 'po',
        },
        performedByUserId: req.user.id,
        disconnectionCategoryId: parse.data.disconnectionCategoryId,
        disconnectionSubCategoryId: parse.data.disconnectionSubCategoryId,
        disconnectionReason: parse.data.disconnectionReason,
        notes: parse.data.notes,
      });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof Error && err.message === 'Account not found') {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  },

  async refreshCrmStatus(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      const change = await commercialChangesService.refreshCrmStatus(req.params.id as string);
      res.json({ change });
    } catch (err) {
      if (err instanceof Error && err.message === 'Commercial change not found') {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  },

  async setActivationDate(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const parse = setActivationDateSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }
    try {
      const change = await commercialChangesService.setActivationDate(
        req.params.id as string,
        new Date(parse.data.activationDate),
      );
      res.json({ change });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message === 'Commercial change not found' ||
          err.message === 'Commercial change has no CRM service-order to update')
      ) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  },

  async disconnectionReasons(_req: AuthedRequest, res: Response) {
    const reasons = await getCrmClient().fetchDisconnectionReasons();
    res.json({ reasons });
  },

  async list(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const type = req.query.type as CommercialChangeType | undefined;
    const allowed: CommercialChangeType[] = ['UPGRADE', 'DOWNGRADE', 'RATE_REVISION', 'DISCONNECTION'];
    if (type && !allowed.includes(type)) {
      res.status(400).json({ error: 'Invalid type' });
      return;
    }
    const changes = await commercialChangesService.list({
      type,
      requester: req.user,
    });
    res.json({ changes });
  },
};
