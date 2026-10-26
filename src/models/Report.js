import { Schema, model } from 'mongoose';

const reportSchema = new Schema(
  {
    reporterId: { type: Schema.Types.ObjectId, required: true },
    targetType: { type: String, enum: ['post', 'comment', 'user'], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    reason: { type: String, enum: ['spam', 'abuse', 'nudity', 'violence', 'other'], required: true },
    details: { type: String, maxlength: 500 },
    status: { type: String, enum: ['open', 'reviewed'], default: 'open' },
  },
  { timestamps: true }
);
reportSchema.index({ reporterId: 1, targetType: 1, targetId: 1 }, { unique: true }); // one report per user per target
reportSchema.index({ status: 1, createdAt: -1 });

export const Report = model('Report', reportSchema);
