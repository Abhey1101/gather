import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/errors.js';
import { User } from '../models/User.js';
import { Post } from '../models/Post.js';
import { getTrending, hydrate } from '../services/feed.service.js';
import { filterVisible } from '../services/follow.service.js';

const router = Router();
router.use(requireAuth);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /api/explore/trending  -> hashtags ranked over the last 24h (Redis sorted-set buckets, one per hour)
router.get('/trending', asyncHandler(async (req, res) => res.json({ hashtags: await getTrending(10) })));

// GET /api/search?q=&type=user|post|hashtag
export const searchRouter = Router();
searchRouter.get(
  '/',
  requireAuth,
  validate({ query: z.object({ q: z.string().trim().min(1).max(100), type: z.enum(['user', 'post', 'hashtag']).default('user') }) }),
  asyncHandler(async (req, res) => {
    const { q, type } = req.query;
    if (type === 'user') {
      // anchored, case-normalised prefix match => can use the unique username index
      const users = await User.find({ username: { $regex: `^${escapeRegex(q.toLowerCase())}` } })
        .select('name username avatarUrl followerCount')
        .limit(10)
        .lean();
      return res.json({ users });
    }
    const rows =
      type === 'hashtag'
        ? await Post.find({ hashtags: q.replace(/^#/, '').toLowerCase() }).select('_id authorId').sort({ createdAt: -1 }).limit(20).lean()
        : await Post.find({ $text: { $search: q } }, { score: { $meta: 'textScore' } }).select('_id authorId').sort({ score: { $meta: 'textScore' } }).limit(20).lean();
    const visible = await filterVisible(rows, req.user.id);
    res.json({ posts: await hydrate(visible.map((p) => String(p._id)), req.user.id) });
  })
);

export default router;
