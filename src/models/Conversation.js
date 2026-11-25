import { Schema, model } from 'mongoose';

const conversationSchema = new Schema(
  {
    participants: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
    participantKey: { type: String, required: true, unique: true },
    lastMessageAt: { type: Date, default: Date.now },
    lastMessagePreview: { type: String, maxlength: 120, default: '' },
  },
  { timestamps: true }
);
conversationSchema.index({ participants: 1, lastMessageAt: -1 });

export const Conversation = model('Conversation', conversationSchema);
