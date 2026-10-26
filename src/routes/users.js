import { Router } from 'express';
import { z } from 'zod';
import { User } from '../models/User.js';
import { Follow } from '../models/Follow.js';
import { Post } from '../models/Post.js';
import { Block } from '../models/Block.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import { asyncHandler, ApiError } from '../utils/errors.js';
import { idParam, pageQuery } from '../utils/schemas.js';
import { paginate } from '../utils/cursor.js';
import { onFollowAccepted, removeFollow, assertCanView } from '../services/follow.service.js';
import { enqueueNotification } from '../queues.js';
import { hydrate } from '../services/feed.service.js';

const router = Router();
router.use(requireAuth);

const PROFILE_FIELDS = 'name username avatarUrl bio website pronouns gender isPrivate followerCount followingCount createdAt';
const EDITABLE_PROFILE_FIELDS = `${PROFILE_FIELDS} email birthday`;
const birthdaySchema = z.union([
  z.literal(''),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Enter a valid date'),
]);
const websiteSchema = z.union([
  z.literal(''),
  z.string().url().max(200).refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'Use an http or https website URL'),
]);
const eitherBlocked = (a, b) => Block.exists({ $or: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] });

router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select(EDITABLE_PROFILE_FIELDS).lean();
    if (!user) throw new ApiError(404, 'User not found');
    res.json({ user });
  })
);

router.patch(
  '/me',
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(60).optional(),
      username: z.string().trim().toLowerCase().regex(/^[a-z0-9_.]{3,30}$/, '3-30 chars: a-z 0-9 _ .').optional(),
      email: z.string().trim().toLowerCase().email().optional(),
      bio: z.string().max(160).optional(),
      avatarUrl: z.union([z.string().url(), z.literal('')]).optional(),
      website: websiteSchema.optional(),
      birthday: birthdaySchema.optional(),
      pronouns: z.string().max(40).optional(),
      gender: z.string().max(40).optional(),
      isPrivate: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    try {
      const user = await User.findByIdAndUpdate(req.user.id, { $set: req.body }, { new: true, runValidators: true }).select(EDITABLE_PROFILE_FIELDS);
      res.json({ user });
    } catch (error) {
      if (error.code === 11000) throw new ApiError(409, 'Username or email already in use');
      throw error;
    }
  })
);

router.get(
  '/suggested',
  asyncHandler(async (req, res) => {
    const [following, blocks] = await Promise.all([
      Follow.distinct('followingId', { followerId: req.user.id }),
      Block.find({ $or: [{ blockerId: req.user.id }, { blockedId: req.user.id }] }).lean(),
    ]);
    const blocked = blocks.flatMap((b) => [b.blockerId, b.blockedId]);
    const users = await User.find({ _id: { $nin: [...following, ...blocked, req.user.id] } })
      .sort({ followerCount: -1 })
      .limit(10)
      .select(PROFILE_FIELDS)
      .lean();
    res.json({ users });
  })
);

router.get(
  '/:username',
  validate({ params: z.object({ username: z.string().toLowerCase() }) }),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ username: req.params.username }).select(`${PROFILE_FIELDS} birthday`).lean();
    if (!user || (await eitherBlocked(req.user.id, user._id))) throw new ApiError(404, 'User not found');
    const isSelf = String(user._id) === req.user.id;
    if (!isSelf) delete user.birthday;
    const rel = isSelf ? null : await Follow.findOne({ followerId: req.user.id, followingId: user._id }).select('status').lean();
    const canView = isSelf || !user.isPrivate || rel?.status === 'accepted';
    res.json({
      user,
      isSelf,
      relationship: isSelf ? 'self' : rel?.status ?? 'none',
      postCount: canView ? await Post.countDocuments({ authorId: user._id }) : null,
    });
  })
);

router.get(
  '/:username/posts',
  validate({ params: z.object({ username: z.string().toLowerCase() }), query: pageQuery }),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ username: req.params.username }).select('_id').lean();
    if (!user || (await eitherBlocked(req.user.id, user._id))) throw new ApiError(404, 'User not found');
    await assertCanView(req.user.id, user._id);
    const { items, nextCursor } = await paginate(Post, { authorId: user._id }, { cursor: req.query.cursor, limit: req.query.limit, select: '_id' });
    res.json({ items: await hydrate(items.map((i) => String(i._id)), req.user.id), nextCursor });
  })
);

router.post(
  '/:id/follow',
  writeLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const me = req.user.id;
    const targetId = req.params.id;
    if (me === targetId) throw new ApiError(400, "You can't follow yourself");
    const target = await User.findById(targetId).select('isPrivate').lean();
    if (!target) throw new ApiError(404, 'User not found');
    if (await eitherBlocked(me, targetId)) throw new ApiError(403, 'Not allowed');

    const status = target.isPrivate ? 'pending' : 'accepted';
    try {
      await Follow.create({ followerId: me, followingId: targetId, status });
    } catch (err) {
      if (err.code !== 11000) throw err;
      const existing = await Follow.findOne({ followerId: me, followingId: targetId }).select('status').lean();
      return res.json({ status: existing?.status ?? status, changed: false }); // idempotent
    }
    if (status === 'accepted') await onFollowAccepted(me, targetId);
    else await enqueueNotification({ type: 'follow_request', actorId: me, recipientId: targetId, entityId: targetId });
    res.status(201).json({ status, changed: true });
  })
);

router.delete(
  '/:id/follow',
  writeLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const prev = await removeFollow(req.user.id, req.params.id);
    res.json({ status: 'none', changed: prev !== null });
  })
);

router.post(
  '/:id/block',
  writeLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const me = req.user.id;
    if (me === req.params.id) throw new ApiError(400, "You can't block yourself");
    if (!(await User.exists({ _id: req.params.id }))) throw new ApiError(404, 'User not found');
    await Block.create({ blockerId: me, blockedId: req.params.id }).catch((err) => {
      if (err.code !== 11000) throw err; // already blocked: idempotent
    });
    await Promise.all([removeFollow(me, req.params.id), removeFollow(req.params.id, me)]);
    res.status(201).json({ blocked: true });
  })
);

router.delete(
  '/:id/block',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await Block.deleteOne({ blockerId: req.user.id, blockedId: req.params.id });
    res.json({ blocked: false });
  })
);

export default router;
