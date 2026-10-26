import { Schema, model } from 'mongoose';

const likeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    postId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
likeSchema.index({ userId: 1, postId: 1 }, { unique: true });
likeSchema.index({ postId: 1, createdAt: -1 }); // used by the feed $lookup

export const Like = model('Like', likeSchema);
