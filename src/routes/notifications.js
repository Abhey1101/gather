import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/errors.js';
import { idParam, pageQuery } from '../utils/schemas.js';
import { paginate } from '../utils/cursor.js';
import { Notification } from '../models/Notification.js';
import { User } from '../models/User.js';
import { getUnreadCount, markAllRead, markRead } from '../services/notification.service.js';

const router = Router();
router.use(requireAuth);

// GET /api/notifications?cursor=
router.get(
  '/',
  validate({ query: pageQuery }),
  asyncHandler(async (req, res) => {
    const { items, nextCursor } = await paginate(Notification, { userId: req.user.id }, { field: 'updatedAt', cursor: req.query.cursor, limit: req.query.limit });
    const actorIds = [...new Set(items.flatMap((n) => n.actors.map(String)))];
    const users = await User.find({ _id: { $in: actorIds } }).select('username name avatarUrl').lean();
    const map = new Map(users.map((u) => [String(u._id), u]));
    res.json({
      items: items.map((n) => ({ ...n, actors: n.actors.map((a) => map.get(String(a))).filter(Boolean) })),
      nextCursor,
      unreadCount: await getUnreadCount(req.user.id),
    });
  })
);

router.get('/unread-count', asyncHandler(async (req, res) => res.json({ unreadCount: await getUnreadCount(req.user.id) })));

// PATCH /api/notifications/read-all
router.patch('/read-all', asyncHandler(async (req, res) => {
  await markAllRead(req.user.id);
  res.json({ unreadCount: 0 });
}));

router.patch('/:id/read', validate({ params: idParam }), asyncHandler(async (req, res) => {
  await markRead(req.user.id, req.params.id);
  res.json({ unreadCount: await getUnreadCount(req.user.id) });
}));

export default router;
