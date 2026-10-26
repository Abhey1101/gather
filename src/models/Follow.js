import { Schema, model } from 'mongoose';

const followSchema = new Schema(
  {
    followerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    followingId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'accepted'], default: 'accepted' },
  },
  { timestamps: true }
);
// Compound unique index = idempotent follows (double clicks / retries cannot create duplicates).
followSchema.index({ followerId: 1, followingId: 1 }, { unique: true });
followSchema.index({ followingId: 1, status: 1, createdAt: -1 }); // fan-out: "who follows X?"
followSchema.index({ followerId: 1, status: 1 }); // "who do I follow?"

export const Follow = model('Follow', followSchema);
