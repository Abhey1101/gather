import { Router } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Post } from '../models/Post.js';
import { Like } from '../models/Like.js';
import { Save } from '../models/Save.js';
import { Comment } from '../models/Comment.js';
import { Report } from '../models/Report.js';
import { User } from '../models/User.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import { asyncHandler, ApiError } from '../utils/errors.js';
import { idParam, pageQuery, objectId } from '../utils/schemas.js';
import { paginate } from '../utils/cursor.js';
import { fanoutQueue, enqueueNotification } from '../queues.js';
import { emitToPost } from '../realtime.js';
import { hydrate, trendingBump } from '../services/feed.service.js';
import { assertCanView } from '../services/follow.service.js';

const router = Router();
router.use(requireAuth);
const uploadsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/uploads');
const localImageExtensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (localImageExtensions[file.mimetype]) return cb(null, true);
    cb(new ApiError(400, 'Choose a JPEG, PNG, WebP, or GIF image'));
  },
});

const uploadToCloudinary = (file) =>
  new Promise((resolve, reject) => {
    // f_auto/q_auto are applied at delivery time; here we cap dimensions so originals stay reasonable.
    cloudinary.uploader
      .upload_stream({ folder: 'socialfeed', transformation: [{ width: 1600, crop: 'limit' }] }, (err, r) =>
        err ? reject(err) : resolve({ url: r.secure_url, publicId: r.public_id, width: r.width, height: r.height })
      )
      .end(file.buffer);
  });

const uploadLocally = async (file) => {
  const filename = `${randomUUID()}${localImageExtensions[file.mimetype]}`;
  await mkdir(uploadsDir, { recursive: true });
  await writeFile(path.join(uploadsDir, filename), file.buffer, { flag: 'wx' });
  return { url: `/uploads/${filename}`, publicId: `local:${filename}` };
};

const extractHashtags = (text) => [...new Set([...text.matchAll(/#([a-z0-9_]{1,50})/gi)].map((m) => m[1].toLowerCase()))].slice(0, 20);
const extractMentions = (text) => [...new Set([...text.matchAll(/@([a-z0-9_.]{3,30})/gi)].map((m) => m[1].toLowerCase()))].slice(0, 5);

router.post(
  '/',
  writeLimiter,
  upload.array('images', 5),
  validate({
    body: z.object({
      caption: z.string().max(2200).default(''),
      location: z.string().max(100).optional(),
      mediaUrls: z.array(z.string().url()).max(5).default([]), // JSON-body alternative when Cloudinary isn't configured
    }),
  }),
  asyncHandler(async (req, res) => {
    let media = req.body.mediaUrls.map((url) => ({ url }));
    if (req.files?.length) {
      const uploadImage = process.env.CLOUDINARY_URL ? uploadToCloudinary : uploadLocally;
      media = await Promise.all(req.files.map(uploadImage));
    }
    if (!req.body.caption.trim() && !media.length) throw new ApiError(400, 'A post needs a caption or media');

    const hashtags = extractHashtags(req.body.caption);
    const post = await Post.create({ authorId: req.user.id, caption: req.body.caption, location: req.body.location, media, hashtags });
    await Promise.all([fanoutQueue.add('fanout-post', { postId: String(post._id) }), trendingBump(hashtags)]);
    res.status(201).json({ post });
  })
);

router.get(
  '/saved',
  validate({ query: pageQuery }),
  asyncHandler(async (req, res) => {
    const { items, nextCursor } = await paginate(Save, { userId: req.user.id }, { cursor: req.query.cursor, limit: req.query.limit });
    res.json({ items: await hydrate(items.map((i) => String(i.postId)), req.user.id), nextCursor });
  })
);

router.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const post = await Post.findById(req.params.id).select('authorId').lean();
    if (!post) throw new ApiError(404, 'Post not found');
    await assertCanView(req.user.id, post.authorId);
    const [item] = await hydrate([req.params.id], req.user.id);
    if (!item) throw new ApiError(404, 'Post not found');
    res.json({ post: item });
  })
);

router.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const post = await Post.findOneAndDelete({ _id: req.params.id, authorId: req.user.id });
    if (!post) throw new ApiError(404, 'Post not found');
    // Feed entries pointing at it are dropped lazily by hydrate() (missing posts are skipped).
    await Promise.all([Like.deleteMany({ postId: post._id }), Comment.deleteMany({ postId: post._id }), Save.deleteMany({ postId: post._id })]);
    res.status(204).end();
  })
);

// ---------- likes (idempotent) ----------
router.post(
  '/:id/like',
  writeLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const post = await Post.findById(req.params.id).select('authorId likeCount').lean();
    if (!post) throw new ApiError(404, 'Post not found');
    await assertCanView(req.user.id, post.authorId);

    let created = false;
    try {
      await Like.create({ userId: req.user.id, postId: post._id });
      created = true;
    } catch (err) {
      if (err.code !== 11000) throw err; // unique index => repeated like is a no-op
    }
    let likeCount = post.likeCount;
    if (created) {
      // $inc is atomic: concurrent likes never lose updates. Only runs when the Like row was really created.
      likeCount = (await Post.findByIdAndUpdate(post._id, { $inc: { likeCount: 1 } }, { new: true }).select('likeCount').lean()).likeCount;
      await enqueueNotification({ type: 'like', actorId: req.user.id, recipientId: String(post.authorId), entityId: String(post._id) });
      emitToPost(String(post._id), 'post:liked', { postId: String(post._id), likeCount });
    }
    res.json({ liked: true, likeCount, changed: created });
  })
);

router.delete(
  '/:id/like',
  writeLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const removed = await Like.deleteOne({ userId: req.user.id, postId: req.params.id });
    const post = removed.deletedCount
      ? await Post.findByIdAndUpdate(req.params.id, { $inc: { likeCount: -1 } }, { new: true }).select('likeCount').lean()
      : await Post.findById(req.params.id).select('likeCount').lean();
    if (!post) throw new ApiError(404, 'Post not found');
    if (removed.deletedCount) emitToPost(req.params.id, 'post:liked', { postId: req.params.id, likeCount: post.likeCount });
    res.json({ liked: false, likeCount: post.likeCount, changed: removed.deletedCount === 1 });
  })
);

// ---------- saves ----------
router.post(
  '/:id/save',
  writeLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const post = await Post.findById(req.params.id).select('authorId').lean();
    if (!post) throw new ApiError(404, 'Post not found');
    await assertCanView(req.user.id, post.authorId);
    await Save.create({ userId: req.user.id, postId: post._id }).catch((err) => {
      if (err.code !== 11000) throw err; // already saved: idempotent
    });
    res.json({ saved: true });
  })
);
router.delete(
  '/:id/save',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await Save.deleteOne({ userId: req.user.id, postId: req.params.id });
    res.json({ saved: false });
  })
);

// ---------- comments ----------
router.post(
  '/:id/comments',
  writeLimiter,
  validate({ params: idParam, body: z.object({ body: z.string().trim().min(1).max(1000), parentId: objectId.optional() }) }),
  asyncHandler(async (req, res) => {
    const post = await Post.findById(req.params.id).select('authorId').lean();
    if (!post) throw new ApiError(404, 'Post not found');
    await assertCanView(req.user.id, post.authorId);

    let parent = null;
    if (req.body.parentId) {
      parent = await Comment.findOne({ _id: req.body.parentId, postId: post._id }).select('userId').lean();
      if (!parent) throw new ApiError(404, 'Parent comment not found');
    }
    const comment = await Comment.create({ postId: post._id, userId: req.user.id, parentId: parent?._id ?? null, body: req.body.body });
    const updated = await Post.findByIdAndUpdate(post._id, { $inc: { commentCount: 1 } }, { new: true }).select('commentCount').lean();

    const jobs = [];
    const base = { actorId: req.user.id, preview: req.body.body };
    if (parent) jobs.push({ ...base, type: 'reply', recipientId: String(parent.userId), entityId: String(parent._id) });
    else jobs.push({ ...base, type: 'comment', recipientId: String(post.authorId), entityId: String(post._id) });

    const names = extractMentions(req.body.body);
    if (names.length) {
      const mentioned = await User.find({ username: { $in: names } }).select('_id').lean();
      for (const m of mentioned) jobs.push({ ...base, type: 'mention', recipientId: String(m._id), entityId: String(comment._id) });
    }
    await Promise.all(jobs.map(enqueueNotification));
    emitToPost(String(post._id), 'comment:new', { postId: String(post._id), commentCount: updated.commentCount, commentId: String(comment._id) });
    res.status(201).json({ comment, commentCount: updated.commentCount });
  })
);

router.get(
  '/:id/comments',
  validate({ params: idParam, query: pageQuery }),
  asyncHandler(async (req, res) => {
    const post = await Post.findById(req.params.id).select('authorId').lean();
    if (!post) throw new ApiError(404, 'Post not found');
    await assertCanView(req.user.id, post.authorId);
    const { items, nextCursor } = await paginate(Comment, { postId: post._id }, { cursor: req.query.cursor, limit: req.query.limit });
    const users = await User.find({ _id: { $in: items.map((c) => c.userId) } }).select('username name avatarUrl').lean();
    const map = new Map(users.map((u) => [String(u._id), u]));
    res.json({ items: items.map((c) => ({ ...c, author: map.get(String(c.userId)) })), nextCursor });
  })
);

router.delete(
  '/:postId/comments/:commentId',
  validate({ params: z.object({ postId: objectId, commentId: objectId }) }),
  asyncHandler(async (req, res) => {
    const post = await Post.findById(req.params.postId).select('authorId').lean();
    if (!post) throw new ApiError(404, 'Post not found');
    const comment = await Comment.findOne({ _id: req.params.commentId, postId: post._id });
    if (!comment) throw new ApiError(404, 'Comment not found');
    // comment author or post owner may delete
    if (String(comment.userId) !== req.user.id && String(post.authorId) !== req.user.id) throw new ApiError(403, 'Not allowed');
    await comment.deleteOne();
    await Post.updateOne({ _id: post._id }, { $inc: { commentCount: -1 } });
    res.status(204).end();
  })
);

// ---------- reporting ----------
router.post(
  '/:id/report',
  writeLimiter,
  validate({ params: idParam, body: z.object({ reason: z.enum(['spam', 'abuse', 'nudity', 'violence', 'other']), details: z.string().max(500).optional() }) }),
  asyncHandler(async (req, res) => {
    if (!(await Post.exists({ _id: req.params.id }))) throw new ApiError(404, 'Post not found');
    await Report.updateOne(
      { reporterId: req.user.id, targetType: 'post', targetId: req.params.id },
      { $setOnInsert: { reason: req.body.reason, ...(req.body.details && { details: req.body.details }) } },
      { upsert: true }
    );
    res.status(201).json({ reported: true });
  })
);

export default router;
