import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/errors.js';
import { pageQuery } from '../utils/schemas.js';
import { getFeed } from '../services/feed.service.js';
import { env } from '../config/env.js';

const router = Router();

// GET /api/feed?cursor=&limit=10
// `strategy=mongo` (ignored in production) forces pure fan-out-on-read: the benchmark baseline.
router.get(
  '/',
  requireAuth,
  validate({ query: pageQuery.extend({ strategy: z.enum(['hybrid', 'mongo']).default('hybrid') }) }),
  asyncHandler(async (req, res) => {
    const strategy = env.NODE_ENV === 'production' ? 'hybrid' : req.query.strategy;
    res.json(await getFeed(req.user.id, { cursor: req.query.cursor, limit: req.query.limit, strategy }));
  })
);

export default router;
