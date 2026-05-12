import type { Response } from 'express';
import { z } from 'zod';
import { meetingsService } from './meetings.service.js';
import type { AuthedRequest } from '../auth/auth.middleware.js';

const actionItemSchema = z.object({
  srNo: z.number().int(),
  discussionDescription: z.string().min(1),
  actionOwner: z.string().default(''),
  planOfAction: z.string().default(''),
  closureDate: z.string().nullable().optional(),
  currentStatus: z.enum(['Open', 'In Progress', 'Closed']).default('Open'),
});

const logSchema = z.object({
  accountId: z.string().uuid(),
  scheduledAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date'),
  agenda: z.string().optional(),
  meetingType: z.enum(['ONLINE', 'PHYSICAL']).default('ONLINE'),
  location: z.string().optional(),
  clientParticipants: z.string().optional(),
  gazonParticipants: z.string().optional(),
  actionItems: z.array(actionItemSchema).optional(),
});

const heldSchema = z.object({
  heldAt: z.string().optional().refine(
    (s) => s === undefined || !Number.isNaN(Date.parse(s)),
    'Invalid date',
  ),
});

const momSchema = z.object({
  momContent: z.string().min(1, 'MoM content is required'),
});

const sendMomEmailSchema = z.object({
  accountId: z.string().uuid(),
  scheduledAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date'),
  meetingType: z.enum(['ONLINE', 'PHYSICAL']).default('ONLINE'),
  location: z.string().optional(),
  agenda: z.string().optional(),
  clientParticipants: z.string().optional(),
  gazonParticipants: z.string().optional(),
  actionItems: z.array(actionItemSchema).optional(),
  momContent: z.string().min(1, 'MoM content is required'),
  to: z.string().email().optional(),
  cc: z.array(z.string().email()).optional(),
  subject: z.string().optional(),
  samDesignation: z.string().optional(),
  samPhone: z.string().optional(),
  testMode: z.boolean().optional().default(false),
});

const completeMeetingSchema = z.object({
  agenda: z.string().optional(),
  clientParticipants: z.string().optional(),
  gazonParticipants: z.string().optional(),
  actionItems: z.array(actionItemSchema).optional(),
  momContent: z.string().min(1, 'MoM content is required'),
  to: z.string().email().optional(),
  cc: z.array(z.string().email()).optional(),
  subject: z.string().optional(),
  samDesignation: z.string().optional(),
  samPhone: z.string().optional(),
  testMode: z.boolean().optional().default(false),
});

function requireUser(req: AuthedRequest, res: Response): { id: string; role: string } | null {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthenticated' });
    return null;
  }
  return req.user;
}

export const meetingsController = {
  async log(req: AuthedRequest, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const parse = logSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }
    try {
      const meeting = await meetingsService.log({
        accountId: parse.data.accountId,
        scheduledAt: new Date(parse.data.scheduledAt),
        agenda: parse.data.agenda ?? null,
        meetingType: parse.data.meetingType,
        location:
          parse.data.meetingType === 'PHYSICAL' ? parse.data.location?.trim() || null : null,
        clientParticipants: parse.data.clientParticipants?.trim() || null,
        gazonParticipants: parse.data.gazonParticipants?.trim() || null,
        actionItems:
          parse.data.actionItems && parse.data.actionItems.length > 0
            ? parse.data.actionItems.map((item, idx) => ({
                srNo: item.srNo || idx + 1,
                discussionDescription: item.discussionDescription,
                actionOwner: item.actionOwner ?? '',
                planOfAction: item.planOfAction ?? '',
                closureDate: item.closureDate ?? null,
                currentStatus: item.currentStatus ?? 'Open',
              }))
            : null,
        performedByUserId: user.id,
      });
      res.status(201).json({ meeting });
    } catch (err) {
      if (err instanceof Error && err.message === 'Account not found') {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  },

  async list(req: AuthedRequest, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
    const recentLimit = req.query.recent === 'true' ? 4 : undefined;
    const meetings = await meetingsService.list({ accountId, recentLimit });
    // SAM scoping: filter to own accounts
    const filtered =
      user.role === 'SAM'
        ? meetings.filter((m) => m.account.samOwnerId === user.id)
        : meetings;
    res.json({ meetings: filtered });
  },

  async getById(req: AuthedRequest, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const meeting = await meetingsService.getById(req.params.id as string);
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    if (user.role === 'SAM' && meeting.account.samOwner?.id !== user.id) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    res.json({ meeting });
  },

  async markHeld(req: AuthedRequest, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const parse = heldSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }
    const heldAt = parse.data.heldAt ? new Date(parse.data.heldAt) : new Date();
    try {
      const meeting = await meetingsService.markHeld({
        meetingId: req.params.id as string,
        heldAt,
        performedByUserId: user.id,
      });
      res.json({ meeting });
    } catch (err) {
      if (err instanceof Error && /Record to update not found/i.test(err.message)) {
        res.status(404).json({ error: 'Meeting not found' });
        return;
      }
      throw err;
    }
  },

  async sendMomEmail(req: AuthedRequest, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const parse = sendMomEmailSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }
    try {
      const result = await meetingsService.sendMomEmail({
        accountId: parse.data.accountId,
        scheduledAt: new Date(parse.data.scheduledAt),
        meetingType: parse.data.meetingType,
        location:
          parse.data.meetingType === 'PHYSICAL' ? parse.data.location?.trim() || null : null,
        agenda: parse.data.agenda?.trim() || null,
        clientParticipants: parse.data.clientParticipants?.trim() || null,
        gazonParticipants: parse.data.gazonParticipants?.trim() || null,
        actionItems:
          parse.data.actionItems && parse.data.actionItems.length > 0
            ? parse.data.actionItems.map((item, idx) => ({
                srNo: item.srNo || idx + 1,
                discussionDescription: item.discussionDescription,
                actionOwner: item.actionOwner ?? '',
                planOfAction: item.planOfAction ?? '',
                closureDate: item.closureDate ?? null,
                currentStatus: item.currentStatus ?? 'Open',
              }))
            : null,
        momContent: parse.data.momContent,
        toOverride: parse.data.to?.trim() || null,
        ccOverride: parse.data.cc ?? null,
        subjectOverride: parse.data.subject?.trim() || null,
        samDesignation: parse.data.samDesignation?.trim() || null,
        samPhone: parse.data.samPhone?.trim() || null,
        testMode: parse.data.testMode,
        performedByUserId: user.id,
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

  async completeMeeting(req: AuthedRequest, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const parse = completeMeetingSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }
    try {
      const result = await meetingsService.completeMeeting({
        meetingId: req.params.id as string,
        agenda: parse.data.agenda?.trim() || null,
        clientParticipants: parse.data.clientParticipants?.trim() || null,
        gazonParticipants: parse.data.gazonParticipants?.trim() || null,
        actionItems:
          parse.data.actionItems && parse.data.actionItems.length > 0
            ? parse.data.actionItems.map((item, idx) => ({
                srNo: item.srNo || idx + 1,
                discussionDescription: item.discussionDescription,
                actionOwner: item.actionOwner ?? '',
                planOfAction: item.planOfAction ?? '',
                closureDate: item.closureDate ?? null,
                currentStatus: item.currentStatus ?? 'Open',
              }))
            : null,
        momContent: parse.data.momContent,
        toOverride: parse.data.to?.trim() || null,
        ccOverride: parse.data.cc ?? null,
        subjectOverride: parse.data.subject?.trim() || null,
        samDesignation: parse.data.samDesignation?.trim() || null,
        samPhone: parse.data.samPhone?.trim() || null,
        testMode: parse.data.testMode,
        performedByUserId: user.id,
      });
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof Error && err.message === 'Meeting not found') {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  },

  async remove(req: AuthedRequest, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const snapshot = await meetingsService.remove({
        meetingId: req.params.id as string,
        performedByUserId: user.id,
      });
      res.json({ deleted: true, snapshot });
    } catch (err) {
      if (err instanceof Error && err.message === 'Meeting not found') {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  },

  async submitMom(req: AuthedRequest, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const parse = momSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }
    try {
      const meeting = await meetingsService.submitMom({
        meetingId: req.params.id as string,
        momContent: parse.data.momContent,
        sentAt: new Date(),
        performedByUserId: user.id,
      });
      res.json({ meeting });
    } catch (err) {
      if (err instanceof Error && /Record to update not found/i.test(err.message)) {
        res.status(404).json({ error: 'Meeting not found' });
        return;
      }
      throw err;
    }
  },
};
