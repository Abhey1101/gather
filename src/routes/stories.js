import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, ApiError } from '../utils/errors.js';
import { idParam } from '../utils/schemas.js';
import { Story } from '../models/Story.js';
import { StoryView } from '../models/StoryView.js';
import { Follow } from '../models/Follow.js';
import { Block } from '../models/Block.js';
import { User } from '../models/User.js';
import { imageUpload, uploadImage } from '../services/media.service.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const followingIds = await Follow.distinct('followingId', { followerId: req.user.id, status: 'accepted' });
    const blocks = await Block.find({ $or: [{ blockerId: req.user.id }, { blockedId: req.user.id }] }).select('blockerId blockedId').lean();
    const excludedIds = new Set(blocks.flatMap((block) => [String(block.blockerId), String(block.blockedId)]));
    const visibleIds = [req.user.id, ...followingIds].filter((id) => !excludedIds.has(String(id)));
    const stories = await Story.find({ authorId: { $in: visibleIds }, expiresAt: { $gt: new Date() } })
      .sort({ createdAt: 1 })
      .limit(300)
      .lean();
    if (!stories.length) return res.json({ stories: [] });

    const storyIds = stories.map((story) => story._id);
    const [authors, views] = await Promise.all([
      User.find({ _id: { $in: [...new Set(stories.map((story) => String(story.authorId)))] } })
        .select('name username avatarUrl')
        .lean(),
      StoryView.find({ storyId: { $in: storyIds }, viewerId: req.user.id }).select('storyId').lean(),
    ]);
    const authorsById = new Map(authors.map((author) => [String(author._id), author]));
    const viewedIds = new Set(views.map((view) => String(view.storyId)));
    const groups = new Map();
    for (const story of stories) {
      const author = authorsById.get(String(story.authorId));
      if (!author) continue;
      const key = String(story.authorId);
      if (!groups.has(key)) groups.set(key, { author, isMine: key === String(req.user.id), stories: [] });
      groups.get(key).stories.push({
        ...story,
        viewedByMe: key !== String(req.user.id) && viewedIds.has(String(story._id)),
      });
    }
    res.json({ stories: [...groups.values()] });
  })
);

router.post(
  '/',
  writeLimiter,
  imageUpload.single('image'),
  validate({ body: z.object({ caption: z.string().max(200).default('') }) }),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'Choose an image for your story');
    const media = await uploadImage(req.file);
    const story = await Story.create({
      authorId: req.user.id,
      media,
      caption: req.body.caption.trim(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    res.status(201).json({ story });
  })
);

router.post(
  '/:id/view',
  writeLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const story = await Story.findOne({ _id: req.params.id, expiresAt: { $gt: new Date() } });
    if (!story) throw new ApiError(404, 'Story not found or expired');
    if (String(story.authorId) === String(req.user.id)) {
      return res.json({ viewed: false, viewCount: story.viewCount });
    }
    const [blocked, following] = await Promise.all([
      Block.exists({
        $or: [
          { blockerId: req.user.id, blockedId: story.authorId },
          { blockerId: story.authorId, blockedId: req.user.id },
        ],
      }),
      Follow.exists({ followerId: req.user.id, followingId: story.authorId, status: 'accepted' }),
    ]);
    if (blocked || !following) throw new ApiError(403, 'You cannot view this story');

    let viewed = false;
    try {
      await StoryView.create({ storyId: story._id, viewerId: req.user.id });
      viewed = true;
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
    const updated = viewed
      ? await Story.findByIdAndUpdate(story._id, { $inc: { viewCount: 1 } }, { new: true }).select('viewCount').lean()
      : story;
    res.json({ viewed, viewCount: updated.viewCount });
  })
);

router.delete(
  '/:id',
  writeLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const story = await Story.findOneAndDelete({ _id: req.params.id, authorId: req.user.id });
    if (!story) throw new ApiError(404, 'Story not found');
    await StoryView.deleteMany({ storyId: story._id });
    res.status(204).end();
  })
);

export default router;
