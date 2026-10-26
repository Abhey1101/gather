import { Schema, model } from 'mongoose';

const blockSchema = new Schema(
  {
    blockerId: { type: Schema.Types.ObjectId, required: true },
    blockedId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
blockSchema.index({ blockedId: 1 });

export const Block = model('Block', blockSchema);
