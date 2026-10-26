import { Schema, model } from 'mongoose';

export const NOTIFICATION_TYPES = ['like', 'comment', 'reply', 'follow', 'follow_request', 'mention'];

const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    // Most recent actors (max 3) + total count => "Aman and 12 others liked your post"
    actors: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    actorCount: { type: Number, default: 0 },
    entityId: { type: Schema.Types.ObjectId, required: true },
    preview: String,
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);
notificationSchema.index({ userId: 1, updatedAt: -1, _id: -1 });
// Only ONE unread notification per (user, type, entity): makes aggregation upserts race-safe.
notificationSchema.index(
  { userId: 1, type: 1, entityId: 1 },
  { unique: true, partialFilterExpression: { isRead: false } }
);

export const Notification = model('Notification', notificationSchema);
