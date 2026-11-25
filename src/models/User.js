import { Schema, model } from 'mongoose';

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9_.]{3,30}$/ },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    avatarUrl: String,
    coverUrl: String,
    bio: { type: String, maxlength: 160, default: '' },
    location: { type: String, maxlength: 100, default: '' },
    website: { type: String, maxlength: 200, default: '' },
    birthday: { type: String, maxlength: 10, default: '' },
    pronouns: { type: String, maxlength: 40, default: '' },
    gender: { type: String, maxlength: 40, default: '' },
    isPrivate: { type: Boolean, default: false },
    followerCount: { type: Number, default: 0 },
    followingCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);
userSchema.index({ followerCount: -1 });

export const User = model('User', userSchema);
