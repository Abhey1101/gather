import { Schema, model } from 'mongoose';

const directMessageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, maxlength: 2000 },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);
directMessageSchema.index({ conversationId: 1, createdAt: -1, _id: -1 });
directMessageSchema.index({ recipientId: 1, readAt: 1, conversationId: 1 });

export const DirectMessage = model('DirectMessage', directMessageSchema);
