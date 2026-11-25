import { Schema, model } from 'mongoose';

const storyViewSchema = new Schema(
  {
    storyId: { type: Schema.Types.ObjectId, ref: 'Story', required: true },
    viewerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
storyViewSchema.index({ storyId: 1, viewerId: 1 }, { unique: true });

export const StoryView = model('StoryView', storyViewSchema);
