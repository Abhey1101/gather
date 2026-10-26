import { Types } from 'mongoose';
import { redis } from '../config/redis.js';
import { env } from '../config/env.js';
import { Post } from '../models/Post.js';
import { Follow } from '../models/Follow.js';
import { User } from '../models/User.js';
import { Block } from '../models/Block.js';
import { Like } from '../models/Like.js';
import { Save } from '../models/Save.js';
import { encodeCursor, parseCursor, cursorFilter } from '../utils/cursor.js';

/**
 * HYBRID FEED
 *  - Normal authors  -> fan-out on WRITE: post id pushed into every follower's Redis sorted set
 *                       (feed:{userId}, score = createdAt ms, member = postId). Reads are O(log n).
 *  - Celebrities     -> fan-out on READ: authors with >= CELEB_THRESHOLD followers are NOT pushed
 *                       (a 1M-follower post would mean 1M writes). Their posts are queried from Mongo
 *                       at read time and merged with the pushed entries.
 * Ordering is (createdAt desc, _id desc). Redis orders equal scores by member (hex ObjectId) descending,
 * which matches that order exactly, so the compound cursor works across both sources.
 */
const MAX = env.FEED_MAX_LEN;
const FEED_TTL = 30 * 86400;
export const feedKey = (id) => `feed:${id}`;

const cmp = (a, b) => b.ms - a.ms || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export async function followedAuthors(userId) {
  const rows = await Follow.find({ followerId: userId, status: 'accepted' }).select('followingId').lean();
  return rows.map((r) => r.followingId);
}

async function celebrityAuthors(followingIds) {
  if (!followingIds.length) return [];
  const docs = await User.find({ _id: { $in: followingIds }, followerCount: { $gte: env.CELEB_THRESHOLD } })
    .select('_id')
    .lean();
  return docs.map((d) => d._id);
}

/** Celebrities this user follows (cached 5 min; invalidated on follow/unfollow). */
export async function getCelebs(userId) {
  const key = `feed:celebs:${userId}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached).map((id) => new Types.ObjectId(id));
  const celebs = await celebrityAuthors(await followedAuthors(userId));
  await redis.set(key, JSON.stringify(celebs.map(String)), 'EX', 300);
  return celebs;
}

/** Cold start / evicted feed: rebuild the pushed part from Mongo (guarded so it can't stampede). */
async function ensureFeed(userId) {
  if (await redis.exists(feedKey(userId))) return;
  if ((await redis.set(`feed:lock:${userId}`, '1', 'EX', 30, 'NX')) === null) return;
  const following = await followedAuthors(userId);
  const celebs = new Set((await celebrityAuthors(following)).map(String));
  const authors = [...following.filter((a) => !celebs.has(String(a))), new Types.ObjectId(userId)];
  const posts = await Post.find({ authorId: { $in: authors } })
    .select('_id createdAt')
    .sort({ createdAt: -1, _id: -1 })
    .limit(MAX)
    .lean();
  if (!posts.length) return;
  const args = posts.flatMap((p) => [p.createdAt.getTime(), String(p._id)]);
  await redis.multi().zadd(feedKey(userId), ...args).expire(feedKey(userId), FEED_TTL).exec();
}

async function redisEntries(userId, cur, n) {
  const key = feedKey(userId);
  const out = [];
  const push = (raw, filter = () => true) => {
    for (let i = 0; i < raw.length; i += 2) if (filter(raw[i])) out.push({ id: raw[i], ms: Number(raw[i + 1]) });
  };
  if (cur) {
    // 1) entries sharing the cursor's exact timestamp but with a smaller id
    push(await redis.zrevrangebyscore(key, cur.ms, cur.ms, 'WITHSCORES'), (id) => id < cur.id);
    // 2) everything strictly older
    push(await redis.zrevrangebyscore(key, `(${cur.ms}`, '-inf', 'WITHSCORES', 'LIMIT', 0, n));
  } else {
    push(await redis.zrevrangebyscore(key, '+inf', '-inf', 'WITHSCORES', 'LIMIT', 0, n));
  }
  return out.slice(0, n);
}

async function mongoPostEntries(authorIds, cur, n) {
  if (!authorIds.length) return [];
  const cf = cursorFilter('createdAt', cur);
  const filter = cf ? { $and: [{ authorId: { $in: authorIds } }, cf] } : { authorId: { $in: authorIds } };
  const rows = await Post.find(filter).select('_id createdAt').sort({ createdAt: -1, _id: -1 }).limit(n).lean();
  return rows.map((r) => ({ id: String(r._id), ms: r.createdAt.getTime() }));
}

/**
 * Turns post ids into enriched feed documents with ONE aggregation:
 * $lookup author + $lookup "did the viewer like this?". Blocked authors are filtered out.
 * Returned in the same order as `ids`.
 */
export async function hydrate(ids, viewerId) {
  if (!ids.length) return [];
  const viewer = new Types.ObjectId(viewerId);
  const blockRows = await Block.find({ $or: [{ blockerId: viewer }, { blockedId: viewer }] }).lean();
  const blocked = blockRows.map((b) => (String(b.blockerId) === String(viewer) ? b.blockedId : b.blockerId));
  const docs = await Post.aggregate([
    { $match: { _id: { $in: ids.map((i) => new Types.ObjectId(i)) }, authorId: { $nin: blocked } } },
    {
      $lookup: {
        from: 'users',
        localField: 'authorId',
        foreignField: '_id',
        pipeline: [{ $project: { username: 1, name: 1, avatarUrl: 1 } }],
        as: 'author',
      },
    },
    { $unwind: '$author' },
    {
      $lookup: {
        from: 'likes',
        localField: '_id',
        foreignField: 'postId',
        pipeline: [{ $match: { userId: viewer } }, { $limit: 1 }],
        as: 'mine',
      },
    },
    { $addFields: { likedByMe: { $gt: [{ $size: '$mine' }, 0] } } },
    { $project: { mine: 0, authorId: 0, __v: 0 } },
  ]);
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const ordered = ids.map((i) => byId.get(i)).filter(Boolean);
  const saved = await Save.find({ userId: viewer, postId: { $in: ordered.map((d) => d._id) } }).select('postId').lean();
  const savedSet = new Set(saved.map((s) => String(s.postId)));
  return ordered.map((d) => ({ ...d, savedByMe: savedSet.has(String(d._id)) }));
}

/**
 * strategy 'hybrid' (default): Redis push-feed + celebrity pull merged.
 * strategy 'mongo' (non-production only): pure fan-out-on-read; used as the benchmark baseline.
 */
export async function getFeed(userId, { cursor, limit = 10, strategy = 'hybrid' } = {}) {
  const cur = parseCursor(cursor);
  const n = limit + 1;
  let entries;
  if (strategy === 'mongo') {
    const authors = [...(await followedAuthors(userId)), new Types.ObjectId(userId)];
    entries = await mongoPostEntries(authors, cur, n);
  } else {
    await ensureFeed(userId);
    const [pushed, pulled] = await Promise.all([
      redisEntries(userId, cur, n),
      getCelebs(userId).then((celebs) => mongoPostEntries(celebs, cur, n)),
    ]);
    const seen = new Set();
    entries = [...pushed, ...pulled].filter((e) => !seen.has(e.id) && seen.add(e.id)).sort(cmp).slice(0, n);
  }
  const hasMore = entries.length > limit;
  const page = hasMore ? entries.slice(0, limit) : entries;
  const items = await hydrate(page.map((e) => e.id), userId);
  const last = page[page.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last.ms, last.id) : null, strategy };
}

// ---- write path (called by the fan-out worker) ----

export async function fanoutPost(postId) {
  const post = await Post.findById(postId).select('authorId createdAt').lean();
  if (!post) return;
  const author = await User.findById(post.authorId).select('followerCount').lean();
  const score = post.createdAt.getTime();
  const member = String(post._id);

  const push = async (userIds) => {
    const p = redis.pipeline();
    for (const id of userIds) {
      const k = feedKey(id);
      p.zadd(k, score, member);
      p.zremrangebyrank(k, 0, -(MAX + 1)); // keep newest MAX entries
      p.expire(k, FEED_TTL);
    }
    await p.exec();
  };

  await push([post.authorId]); // own posts always appear in own feed
  if (author.followerCount >= env.CELEB_THRESHOLD) return; // celebrity: fan-out on read

  const cursor = Follow.find({ followingId: post.authorId, status: 'accepted' }).select('followerId').lean().cursor({ batchSize: 1000 });
  let batch = [];
  for await (const f of cursor) {
    batch.push(f.followerId);
    if (batch.length >= 1000) {
      await push(batch);
      batch = [];
    }
  }
  if (batch.length) await push(batch);
}

export async function unfollowCleanup({ followerId, followingId }) {
  const posts = await Post.find({ authorId: followingId }).select('_id').sort({ createdAt: -1 }).limit(MAX).lean();
  if (posts.length) await redis.zrem(feedKey(followerId), ...posts.map((p) => String(p._id)));
}

/** Backfill a few of the target's recent posts into a new follower's feed. */
export async function backfillFeed(followerId, target) {
  if (target.followerCount >= env.CELEB_THRESHOLD) return;
  const posts = await Post.find({ authorId: target._id }).select('_id createdAt').sort({ createdAt: -1, _id: -1 }).limit(20).lean();
  if (!posts.length || !(await redis.exists(feedKey(followerId)))) return;
  await redis.zadd(feedKey(followerId), ...posts.flatMap((p) => [p.createdAt.getTime(), String(p._id)]));
}

export async function trendingBump(hashtags) {
  if (!hashtags.length) return;
  const key = `trending:h:${Math.floor(Date.now() / 3_600_000)}`;
  const p = redis.pipeline();
  for (const t of hashtags) p.zincrby(key, 1, t);
  p.expire(key, 2 * 86400);
  await p.exec();
}

export async function getTrending(limit = 10) {
  if (!(await redis.exists('trending:24h'))) {
    const hour = Math.floor(Date.now() / 3_600_000);
    const keys = Array.from({ length: 24 }, (_, i) => `trending:h:${hour - i}`);
    await redis.multi().zunionstore('trending:24h', keys.length, ...keys).expire('trending:24h', 60).exec();
  }
  const raw = await redis.zrevrange('trending:24h', 0, limit - 1, 'WITHSCORES');
  const out = [];
  for (let i = 0; i < raw.length; i += 2) out.push({ hashtag: raw[i], posts: Number(raw[i + 1]) });
  return out;
}

export const hasLiked = (userId, postId) => Like.exists({ userId, postId });
