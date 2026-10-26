import { Schema, model } from 'mongoose';

const saveSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    postId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
saveSchema.index({ userId: 1, postId: 1 }, { unique: true });
saveSchema.index({ userId: 1, createdAt: -1, _id: -1 });

export const Save = model('Save', saveSchema);
