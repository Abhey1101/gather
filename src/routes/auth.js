import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { User } from '../models/User.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { issueTokens, rotateTokens, revokeToken } from '../services/token.service.js';
import { asyncHandler, ApiError } from '../utils/errors.js';
import { env } from '../config/env.js';

const router = Router();
const COST = env.NODE_ENV === 'test' ? 4 : 10;

const publicUser = (u) => ({
  id: u._id, name: u.name, username: u.username, email: u.email, avatarUrl: u.avatarUrl, coverUrl: u.coverUrl, bio: u.bio, location: u.location,
  isPrivate: u.isPrivate, followerCount: u.followerCount, followingCount: u.followingCount,
});

router.post(
  '/register',
  authLimiter,
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(60),
      username: z.string().trim().toLowerCase().regex(/^[a-z0-9_.]{3,30}$/, '3-30 chars: a-z 0-9 _ .'),
      email: z.string().trim().toLowerCase().email(),
      password: z.string().min(8).max(100),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { password, ...rest } = req.body;
    try {
      const user = await User.create({ ...rest, passwordHash: await bcrypt.hash(password, COST) });
      res.status(201).json({ user: publicUser(user), ...(await issueTokens(user._id)) });
    } catch (err) {
      if (err.code === 11000) throw new ApiError(409, 'Username or email already in use');
      throw err;
    }
  })
);

router.post(
  '/login',
  authLimiter,
  validate({ body: z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ email: req.body.email }).select('+passwordHash');
    const ok = user && (await bcrypt.compare(req.body.password, user.passwordHash));
    if (!ok) throw new ApiError(401, 'Invalid email or password');
    res.json({ user: publicUser(user), ...(await issueTokens(user._id)) });
  })
);

router.post(
  '/refresh',
  authLimiter,
  validate({ body: z.object({ refreshToken: z.string().min(10) }) }),
  asyncHandler(async (req, res) => {
    const { accessToken, refreshToken } = await rotateTokens(req.body.refreshToken);
    res.json({ accessToken, refreshToken });
  })
);

router.post(
  '/logout',
  validate({ body: z.object({ refreshToken: z.string().min(10) }) }),
  asyncHandler(async (req, res) => {
    await revokeToken(req.body.refreshToken);
    res.status(204).end();
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id);
    if (!user) throw new ApiError(404, 'User not found');
    res.json({ user: publicUser(user) });
  })
);

export default router;
