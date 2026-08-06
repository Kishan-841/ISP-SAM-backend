import type { Request, Response } from 'express';
import { feedbackService, FeedbackValidationError } from './feedback.service.js';
import type { AuthedRequest } from '../auth/auth.middleware.js';

export const feedbackController = {
  /** Public — questions + SAM dropdown options. */
  async getForm(_req: Request, res: Response) {
    const form = await feedbackService.getForm();
    res.json(form);
  },

  /** Public — submit a completed survey. */
  async submit(req: Request, res: Response) {
    const body = (req.body ?? {}) as { responses?: unknown };
    // Accept either { responses: {...} } (spec shape) or a flat answers object.
    const answers =
      body.responses && typeof body.responses === 'object'
        ? (body.responses as Record<string, unknown>)
        : (req.body as Record<string, unknown>);
    try {
      const result = await feedbackService.submit(answers);
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof FeedbackValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  },

  /** Admin — list submissions (scoped for SAM_HEAD). */
  async list(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const rows = await feedbackService.list({ requester: req.user });
    res.json({ feedbacks: rows });
  },

  /** Admin — full detail of one submission. */
  async getById(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'id required' });
      return;
    }
    const fb = await feedbackService.getById(id, { requester: req.user });
    if (!fb) {
      res.status(404).json({ error: 'Feedback not found' });
      return;
    }
    res.json(fb);
  },
};
