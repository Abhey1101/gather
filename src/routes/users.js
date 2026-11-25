import { Router } from 'express';
import { z } from 'zod';
import { User } from '../models/User.js';
import { Follow } from '../models/Follow.js';
import { ProfileView } from '../models/ProfileView.js';
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

const PROFILE_FIELDS = 'name username avatarUrl coverUrl bio location website pronouns gender isPrivate followerCount followingCount createdAt';
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

async function getConnections(req, res, direction) {
  const profile = await User.findOne({ username: req.params.username }).select('_id isPrivate').lean();
  if (!profile || (await eitherBlocked(req.user.id, profile._id))) throw new ApiError(404, 'User not found');
  await assertCanView(req.user.id, profile._id);

  const relevantBlocks = await Block.find({
    $or: [
      { blockerId: profile._id }, { blockedId: profile._id },
      { blockerId: req.user.id }, { blockedId: req.user.id },
    ],
  }).select('blockerId blockedId').lean();
  const excluded = new Set([String(profile._id)]);
  for (const block of relevantBlocks) {
    if ([String(profile._id), req.user.id].includes(String(block.blockerId))) excluded.add(String(block.blockedId));
    if ([String(profile._id), req.user.id].includes(String(block.blockedId))) excluded.add(String(block.blockerId));
  }

  const filter = direction === 'followers'
    ? { followingId: profile._id, followerId: { $nin: [...excluded] }, status: 'accepted' }
    : { followerId: profile._id, followingId: { $nin: [...excluded] }, status: 'accepted' };
  const { items, nextCursor } = await paginate(Follow, filter, {
    cursor: req.query.cursor,
    limit: req.query.limit,
    select: 'followerId followingId createdAt',
  });
  const userIds = items.map((item) => direction === 'followers' ? item.followerId : item.followingId);
  const [users, relationships] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select(PROFILE_FIELDS).lean(),
    Follow.find({ followerId: req.user.id, followingId: { $in: userIds } }).select('followingId status').lean(),
  ]);
  const userById = new Map(users.map((user) => [String(user._id), user]));
  const relationshipById = new Map(relationships.map((relation) => [String(relation.followingId), relation.status]));
  res.json({
    items: userIds.flatMap((id) => {
      const user = userById.get(String(id));
      return user ? [{ ...user, relationship: relationshipById.get(String(user._id)) || 'none' }] : [];
    }),
    nextCursor,
  });
}

router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select(EDITABLE_PROFILE_FIELDS).lean();
    if (!user) throw new ApiError(404, 'User not found');
    res.json({ user });
  })
);

router.get(
  '/me/analytics',
  validate({ query: z.object({ period: z.enum(['1d', '7d', '30d']).default('30d') }) }),
  asyncHandler(async (req, res) => {
    const now = new Date();
    const period = req.query.period;
    const hours = period === '1d' ? 24 : period === '7d' ? 24 * 7 : 24 * 30;
    const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
    const unit = period === '1d' ? 'hour' : 'day';
    const user = await User.findById(req.user.id).select('followerCount followingCount').lean();
    if (!user) throw new ApiError(404, 'User not found');
    const groupedViews = await ProfileView.aggregate([
      { $match: { profileId: user._id, viewedAt: { $gte: start, $lte: now } } },
      { $group: { _id: { $dateTrunc: { date: '$viewedAt', unit } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    const bucketCount = period === '1d' ? 24 : period === '7d' ? 7 : 30;
    const bucketStart = new Date(now);
    if (unit === 'hour') {
      bucketStart.setUTCMinutes(0, 0, 0);
      bucketStart.setUTCHours(bucketStart.getUTCHours() - (bucketCount - 1));
    } else {
      bucketStart.setUTCHours(0, 0, 0, 0);
      bucketStart.setUTCDate(bucketStart.getUTCDate() - (bucketCount - 1));
    }

    const counts = new Map(groupedViews.map(({ _id, count }) => [new Date(_id).toISOString(), count]));
    const buckets = Array.from({ length: bucketCount }, (_, index) => {
      const date = new Date(bucketStart);
      if (unit === 'hour') date.setUTCHours(date.getUTCHours() + index);
      else date.setUTCDate(date.getUTCDate() + index);
      return { date: date.toISOString(), count: counts.get(date.toISOString()) || 0 };
    });

    res.json({
      period,
      profileViews: groupedViews.reduce((sum, item) => sum + item.count, 0),
      followers: user.followerCount,
      following: user.followingCount,
      buckets,
    });
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
      location: z.string().trim().max(100).optional(),
      avatarUrl: z.union([z.string().url(), z.literal('')]).optional(),
      coverUrl: z.union([z.string().url(), z.literal('')]).optional(),
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
    if (canView && !isSelf) {
      const viewedAt = new Date();
      const viewDate = new Date(Date.UTC(viewedAt.getUTCFullYear(), viewedAt.getUTCMonth(), viewedAt.getUTCDate()));
      try {
        await ProfileView.create({ profileId: user._id, viewerId: req.user.id, viewedAt, viewDate });
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
    }
    res.json({
      user,
      isSelf,
      relationship: isSelf ? 'self' : rel?.status ?? 'none',
      postCount: canView ? await Post.countDocuments({ authorId: user._id }) : null,
    });
  })
);

router.get(
  '/:username/followers',
  validate({ params: z.object({ username: z.string().toLowerCase() }), query: pageQuery }),
  asyncHandler((req, res) => getConnections(req, res, 'followers'))
);

router.get(
  '/:username/following',
  validate({ params: z.object({ username: z.string().toLowerCase() }), query: pageQuery }),
  asyncHandler((req, res) => getConnections(req, res, 'following'))
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
