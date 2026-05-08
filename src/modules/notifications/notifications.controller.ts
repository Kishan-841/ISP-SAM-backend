import type { Response } from 'express';
import type { AuthedRequest } from '../auth/auth.middleware.js';
import {
  dismissNotification,
  getNotifications,
  markAllAsRead,
  markAsRead,
} from './notifications.service.js';

export const notificationsController = {
  async list(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 50;
    const data = await getNotifications({
      requester: req.user,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 50,
    });
    res.json(data);
  },

  /** Lightweight badge endpoint — returns only the unread count. */
  async unreadCount(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    // Re-use the feed for now — unread is included in the response.
    const data = await getNotifications({ requester: req.user, page: 1, pageSize: 1 });
    res.json({ unread: data.unread });
  },

  async markRead(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const id = req.params.id as string;
    if (!id) {
      res.status(400).json({ error: 'Notification id is required' });
      return;
    }
    await markAsRead({ userId: req.user.id, auditLogId: id });
    res.json({ ok: true });
  },

  async dismiss(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const id = req.params.id as string;
    if (!id) {
      res.status(400).json({ error: 'Notification id is required' });
      return;
    }
    await dismissNotification({ userId: req.user.id, auditLogId: id });
    res.json({ ok: true });
  },

  async markAll(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const data = await markAllAsRead({ requester: req.user });
    res.json(data);
  },
};
