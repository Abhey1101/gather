import { Follow } from '../models/Follow.js';
import { User } from '../models/User.js';
import { redis } from '../config/redis.js';
import { enqueueNotification, fanoutQueue } from '../queues.js';
import { backfillFeed } from './feed.service.js';
import { ApiError } from '../utils/errors.js';

/** Called exactly once per accepted follow (state transition is guarded by an atomic conditional update). */
export async function onFollowAccepted(followerId, followingId) {
  const [target] = await Promise.all([
    User.findByIdAndUpdate(followingId, { $inc: { followerCount: 1 } }, { new: true }).select('followerCount').lean(),
    User.updateOne({ _id: followerId }, { $inc: { followingCount: 1 } }),
    redis.del(`feed:celebs:${followerId}`),
  ]);
  await backfillFeed(followerId, { _id: followingId, followerCount: target?.followerCount ?? 0 });
  await enqueueNotification({ type: 'follow', actorId: String(followerId), recipientId: String(followingId), entityId: String(followingId) });
}

/** Removes a follow edge in either state and keeps counters + feed consistent. Returns previous status or null. */
export async function removeFollow(followerId, followingId) {
  const deleted = await Follow.findOneAndDelete({ followerId, followingId });
  if (!deleted) return null;
  if (deleted.status === 'accepted') {
    await Promise.all([
      User.updateOne({ _id: followingId }, { $inc: { followerCount: -1 } }),
      User.updateOne({ _id: followerId }, { $inc: { followingCount: -1 } }),
      redis.del(`feed:celebs:${followerId}`),
      fanoutQueue.add('unfollow-cleanup', { followerId: String(followerId), followingId: String(followingId) }),
    ]);
  }
  return deleted.status;
}

/** Can `viewerId` see content of `authorId`? (public, self, or accepted follower) */
export async function assertCanView(viewerId, authorId) {
  if (String(viewerId) === String(authorId)) return;
  const author = await User.findById(authorId).select('isPrivate').lean();
  if (!author) throw new ApiError(404, 'User not found');
  if (!author.isPrivate) return;
  const ok = await Follow.exists({ followerId: viewerId, followingId: authorId, status: 'accepted' });
  if (!ok) throw new ApiError(403, 'This account is private');
}

/** Filters a list of {_id, authorId} down to ones the viewer may see (used by search). */
export async function filterVisible(posts, viewerId) {
  const authorIds = [...new Set(posts.map((p) => String(p.authorId)))];
  const priv = await User.find({ _id: { $in: authorIds }, isPrivate: true }).select('_id').lean();
  if (!priv.length) return posts;
  const privSet = new Set(priv.map((u) => String(u._id)));
  const allowed = await Follow.find({ followerId: viewerId, followingId: { $in: [...privSet] }, status: 'accepted' }).select('followingId').lean();
  const allowedSet = new Set(allowed.map((f) => String(f.followingId)));
  return posts.filter((p) => !privSet.has(String(p.authorId)) || allowedSet.has(String(p.authorId)) || String(p.authorId) === String(viewerId));
}
