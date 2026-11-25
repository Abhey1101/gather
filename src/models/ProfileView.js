import { Schema, model } from 'mongoose';

const profileViewSchema = new Schema(
  {
    profileId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    viewerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    viewedAt: { type: Date, required: true, default: Date.now },
    viewDate: { type: Date, required: true },
  },
  { versionKey: false }
);

profileViewSchema.index({ profileId: 1, viewerId: 1, viewDate: 1 }, { unique: true });
profileViewSchema.index({ profileId: 1, viewedAt: 1 });
profileViewSchema.index({ viewedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const ProfileView = model('ProfileView', profileViewSchema);
