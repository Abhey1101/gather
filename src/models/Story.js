import { Schema, model } from 'mongoose';

const storySchema = new Schema(
  {
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    media: { url: { type: String, required: true }, publicId: String },
    caption: { type: String, maxlength: 200, default: '' },
    expiresAt: { type: Date, required: true },
    viewCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);
storySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
storySchema.index({ authorId: 1, expiresAt: 1 });

export const Story = model('Story', storySchema);
