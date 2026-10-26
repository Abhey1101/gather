import { Schema, model } from 'mongoose';

const postSchema = new Schema(
  {
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    caption: { type: String, default: '', maxlength: 2200 },
    media: [{ url: String, publicId: String, width: Number, height: Number, _id: false }],
    hashtags: [{ type: String, lowercase: true }],
    location: { type: String, maxlength: 100 },
    likeCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);
// Matches both the profile grid and the fan-out-on-read feed query (sorted $in uses an index merge-sort).
postSchema.index({ authorId: 1, createdAt: -1, _id: -1 });
postSchema.index({ hashtags: 1, createdAt: -1 });
postSchema.index({ caption: 'text' });

export const Post = model('Post', postSchema);
