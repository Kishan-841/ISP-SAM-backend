import type { Response } from 'express';
import { z } from 'zod';
import type { CommercialChangeType } from '@prisma/client';
import { commercialChangesService } from './commercial-changes.service.js';
import { DISCONNECTION_REASONS } from './disconnection-reasons.js';
import type { AuthedRequest } from '../auth/auth.middleware.js';

const bodySchema = z.object({
  accountId: z.string().uuid(),
  changeType: z.enum(['UPGRADE', 'DOWNGRADE', 'RATE_REVISION', 'DISCONNECTION']),
  newArc: z.coerce.number().nonnegative(),
  newBandwidthMbps: z.coerce.number().int().nonnegative().optional(),
  effectiveDate: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date'),
  mailReceivedDate: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid mail-received date')
    .optional(),
  reason: z.string().optional(),
  // Disconnection-only — required server-side when changeType=DISCONNECTION.
  disconnectionCategoryId: z.string().optional(),
  disconnectionSubCategoryId: z.string().optional(),
  disconnectionReason: z.string().optional(),
  // Quick-disconnect workflow (DISCONNECTION rows only). The service does
  // the full validation — including the QUICK_DISCONNECT_ENABLED feature
  // gate, the 1..15 day range, and the min-10-char reason check.
  disconnectionMode: z.enum(['NORMAL', 'QUICK']).optional(),
  quickRequestedDays: z.coerce.number().int().optional(),
  quickApprovalReason: z.string().optional(),
  notes: z.string().optional(),
});

const setActivationDateSchema = z.object({
  activationDate: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date'),
});

const retentionDecisionSchema = z.object({
  decision: z.enum(['RETAIN', 'PROCEED']),
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
    // At least ONE of approval / PO must be uploaded. Both is still better
    // (compliance), but a single doc is acceptable to unblock the workflow.
    //
    // Test-mode bypass: two gates must align for the doc requirement to be
    // skipped — SAM_TEST_MODE=true on the backend (allows the feature) AND
    // the form's runtime toggle sent `testMode=true` on this request.
    // Production must NEVER set the env flag. The audit log payload stamps
    // `testMode: true` on every bypassed commit so it's forensically clear.
    const testModeAllowed = process.env.SAM_TEST_MODE === 'true';
    const testModeRequested =
      req.body?.testMode === 'true' || req.body?.testMode === true;
    const bypassDocs = testModeAllowed && testModeRequested;
    if (!approvalFile && !poFile && !bypassDocs) {
      res.status(422).json({
        error: 'Attach at least one document — client approval or PO.',
      });
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
        newArc: parse.data.newArc,
        newBandwidthMbps: parse.data.newBandwidthMbps ?? null,
        effectiveDate: new Date(parse.data.effectiveDate),
        mailReceivedDate: parse.data.mailReceivedDate
          ? new Date(parse.data.mailReceivedDate)
          : null,
        reason: parse.data.reason ?? null,
        approvalFile: approvalFile
          ? {
              buffer: approvalFile.buffer,
              originalName: approvalFile.originalname ?? 'approval',
            }
          : undefined,
        poFile: poFile
          ? {
              buffer: poFile.buffer,
              originalName: poFile.originalname ?? 'po',
            }
          : undefined,
        performedByUserId: req.user.id,
        disconnectionCategoryId: parse.data.disconnectionCategoryId,
        disconnectionSubCategoryId: parse.data.disconnectionSubCategoryId,
        disconnectionReason: parse.data.disconnectionReason,
        disconnectionMode: parse.data.disconnectionMode,
        quickRequestedDays: parse.data.quickRequestedDays,
        quickApprovalReason: parse.data.quickApprovalReason,
        notes: parse.data.notes,
        testMode: bypassDocs,
      });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof Error && err.message === 'Account not found') {
        res.status(404).json({ error: err.message });
        return;
      }
      // Lifecycle-guard messages from the service surface as 422 so the form
      // can render the message verbatim. The prefix is a stable code the UI
      // can match on if it ever needs to branch on type.
      if (
        err instanceof Error &&
        /^(ACCOUNT_TERMINATED|ACCOUNT_DISCONNECTING|DISCONNECTION_IN_FLIGHT|ACCOUNT_PENDING_QUICK_APPROVAL|QUICK_DISCONNECT_DISABLED|QUICK_DISCONNECT_INVALID_DAYS|QUICK_DISCONNECT_REASON_REQUIRED):/.test(err.message)
      ) {
        res.status(422).json({ error: err.message });
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
    // SAM owns this taxonomy now — see modules/commercial-changes/disconnection-reasons.ts.
    // Returned with the same shape the form has always consumed, so the
    // CRM bridge can stay unaware of how the categories are sourced.
    res.json({ reasons: DISCONNECTION_REASONS });
  },

  async retentionDecision(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const parse = retentionDecisionSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }
    try {
      const change = await commercialChangesService.retentionDecision(
        req.params.id as string,
        parse.data.decision,
        req.user.id,
      );
      res.json({ change });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Retention decision failed';
      if (msg === 'Commercial change not found') {
        res.status(404).json({ error: msg });
        return;
      }
      if (
        msg.includes('disconnection') ||
        msg.includes('already been decided') ||
        msg.includes('21-day')
      ) {
        res.status(400).json({ error: msg });
        return;
      }
      throw err;
    }
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
