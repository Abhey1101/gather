import { Schema, model } from 'mongoose';

const commentSchema = new Schema(
  {
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'Comment', default: null },
    body: { type: String, required: true, maxlength: 1000 },
    likeCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);
commentSchema.index({ postId: 1, createdAt: -1, _id: -1 });

export const Comment = model('Comment', commentSchema);
