import { Notification } from '../models/Notification.js';
import { User } from '../models/User.js';
import { redis } from '../config/redis.js';
import { emitToUser } from '../realtime.js';

const unreadKey = (id) => `unread:${id}`;

export async function getUnreadCount(userId) {
  const cached = await redis.get(unreadKey(userId));
  if (cached !== null) return Number(cached);
  const n = await Notification.countDocuments({ userId, isRead: false });
  await redis.set(unreadKey(userId), n);
  return n;
}

export async function markAllRead(userId) {
  await Notification.updateMany({ userId, isRead: false }, { $set: { isRead: true } });
  await redis.set(unreadKey(userId), 0);
}

export async function markRead(userId, notificationId) {
  const r = await Notification.updateOne({ _id: notificationId, userId, isRead: false }, { $set: { isRead: true } });
  if (r.modifiedCount) {
    const v = await redis.decr(unreadKey(userId));
    if (v < 0) await redis.set(unreadKey(userId), 0);
  }
}

/**
 * AGGREGATION: one unread document per (user, type, entity). Further events bump `actorCount`
 * and push the actor onto a capped list of the 3 most recent actors -> "A and 12 others liked your post".
 * The partial unique index makes concurrent upserts safe; a losing upsert throws E11000 and BullMQ retries it.
 */
export async function processNotification({ type, actorId, recipientId, entityId, preview }) {
  if (String(actorId) === String(recipientId)) return;

  const update = {
    $push: { actors: { $each: [actorId], $position: 0, $slice: 3 } },
    $inc: { actorCount: 1 },
  };
  if (preview) update.$set = { preview: preview.slice(0, 120) };

  const res = await Notification.findOneAndUpdate(
    { userId: recipientId, type, entityId, isRead: false },
    update,
    { upsert: true, new: true, includeResultMetadata: true }
  );
  const doc = res.value;
  const created = !res.lastErrorObject.updatedExisting;

  let unreadCount;
  if (created) {
    // Only a NEW unread document raises the badge. If the counter was never seeded, seed from Mongo (includes this doc).
    unreadCount = (await redis.exists(unreadKey(recipientId))) ? await redis.incr(unreadKey(recipientId)) : await getUnreadCount(recipientId);
  } else {
    unreadCount = await getUnreadCount(recipientId);
  }

  const actors = await User.find({ _id: { $in: doc.actors } }).select('username name avatarUrl').lean();
  const order = new Map(doc.actors.map((a, i) => [String(a), i]));
  actors.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));

  emitToUser(recipientId, 'notification:new', {
    id: String(doc._id),
    type: doc.type,
    entityId: String(doc.entityId),
    actors,
    actorCount: doc.actorCount,
    preview: doc.preview,
    updatedAt: doc.updatedAt,
    unreadCount,
  });
}
