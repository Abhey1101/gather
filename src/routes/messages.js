import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, ApiError } from '../utils/errors.js';
import { objectId, pageQuery } from '../utils/schemas.js';
import { Conversation } from '../models/Conversation.js';
import { DirectMessage } from '../models/DirectMessage.js';
import { User } from '../models/User.js';
import { Block } from '../models/Block.js';
import { paginate } from '../utils/cursor.js';
import { emitToUser } from '../realtime.js';

const router = Router();
router.use(requireAuth);

async function findOtherParticipant(conversation, userId) {
  const otherId = conversation.participants.find((id) => String(id) !== String(userId));
  if (!otherId) throw new ApiError(404, 'Conversation not found');
  const [blocked, user] = await Promise.all([
    Block.exists({
      $or: [
        { blockerId: userId, blockedId: otherId },
        { blockerId: otherId, blockedId: userId },
      ],
    }),
    User.findById(otherId).select('name username avatarUrl').lean(),
  ]);
  if (blocked) throw new ApiError(403, 'Messaging is unavailable for this conversation');
  if (!user) throw new ApiError(404, 'Conversation not found');
  return user;
}

function messageDto(message) {
  return {
    _id: message._id,
    conversationId: message.conversationId,
    sender: message.senderId,
    recipientId: message.recipientId,
    body: message.body,
    readAt: message.readAt,
    createdAt: message.createdAt,
  };
}

router.post(
  '/conversations',
  writeLimiter,
  validate({ body: z.object({ username: z.string().trim().min(3).max(30).regex(/^[a-z0-9_.]+$/i) }) }),
  asyncHandler(async (req, res) => {
    const recipient = await User.findOne({ username: req.body.username.toLowerCase() }).select('name username avatarUrl').lean();
    if (!recipient) throw new ApiError(404, 'User not found');
    if (String(recipient._id) === String(req.user.id)) throw new ApiError(400, 'You cannot message yourself');
    const blocked = await Block.exists({
      $or: [
        { blockerId: req.user.id, blockedId: recipient._id },
        { blockerId: recipient._id, blockedId: req.user.id },
      ],
    });
    if (blocked) throw new ApiError(403, 'Messaging is unavailable for this user');

    const participantIds = [String(req.user.id), String(recipient._id)].sort();
    const participantKey = participantIds.join(':');
    let conversation;
    try {
      conversation = await Conversation.findOneAndUpdate(
        { participantKey },
        { $setOnInsert: { participantKey, participants: participantIds } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      conversation = await Conversation.findOne({ participantKey });
    }
    res.status(200).json({ conversation, otherUser: recipient });
  })
);

router.get(
  '/conversations',
  asyncHandler(async (req, res) => {
    const conversations = await Conversation.find({ participants: req.user.id }).sort({ lastMessageAt: -1 }).limit(50).lean();
    if (!conversations.length) return res.json({ conversations: [] });
    const otherIds = conversations
      .map((conversation) => conversation.participants.find((id) => String(id) !== String(req.user.id)))
      .filter(Boolean);
    const [users, blocks, unread] = await Promise.all([
      User.find({ _id: { $in: otherIds } }).select('name username avatarUrl').lean(),
      Block.find({
        $or: [
          { blockerId: req.user.id, blockedId: { $in: otherIds } },
          { blockerId: { $in: otherIds }, blockedId: req.user.id },
        ],
      }).select('blockerId blockedId').lean(),
      DirectMessage.aggregate([
        {
          $match: {
            recipientId: new Types.ObjectId(req.user.id),
            readAt: null,
            conversationId: { $in: conversations.map((conversation) => conversation._id) },
          },
        },
        { $group: { _id: '$conversationId', count: { $sum: 1 } } },
      ]),
    ]);
    const userById = new Map(users.map((user) => [String(user._id), user]));
    const blockedIds = new Set(blocks.flatMap((block) => [String(block.blockerId), String(block.blockedId)]));
    const unreadByConversation = new Map(unread.map((item) => [String(item._id), item.count]));
    res.json({
      conversations: conversations.flatMap((conversation) => {
        const otherId = conversation.participants.find((id) => String(id) !== String(req.user.id));
        const otherUser = userById.get(String(otherId));
        if (!otherUser || blockedIds.has(String(otherId))) return [];
        return [{ ...conversation, otherUser, unreadCount: unreadByConversation.get(String(conversation._id)) || 0 }];
      }),
    });
  })
);

router.get(
  '/conversations/:id/messages',
  validate({ params: z.object({ id: objectId }), query: pageQuery }),
  asyncHandler(async (req, res) => {
    const conversation = await Conversation.findOne({ _id: req.params.id, participants: req.user.id }).lean();
    if (!conversation) throw new ApiError(404, 'Conversation not found');
    await findOtherParticipant(conversation, req.user.id);
    await DirectMessage.updateMany(
      { conversationId: conversation._id, recipientId: req.user.id, readAt: null },
      { $set: { readAt: new Date() } }
    );
    const page = await paginate(
      DirectMessage,
      { conversationId: conversation._id },
      { cursor: req.query.cursor, limit: req.query.limit }
    );
    const items = await DirectMessage.populate(page.items, { path: 'senderId', select: 'name username avatarUrl' });
    res.json({ messages: items.reverse().map(messageDto), nextCursor: page.nextCursor });
  })
);

router.post(
  '/conversations/:id/messages',
  writeLimiter,
  validate({
    params: z.object({ id: objectId }),
    body: z.object({ body: z.string().trim().min(1).max(2000) }),
  }),
  asyncHandler(async (req, res) => {
    const conversation = await Conversation.findOne({ _id: req.params.id, participants: req.user.id });
    if (!conversation) throw new ApiError(404, 'Conversation not found');
    const recipient = await findOtherParticipant(conversation, req.user.id);
    const message = await DirectMessage.create({
      conversationId: conversation._id,
      senderId: req.user.id,
      recipientId: recipient._id,
      body: req.body.body,
    });
    conversation.lastMessageAt = message.createdAt;
    conversation.lastMessagePreview = message.body.slice(0, 120);
    await conversation.save();
    const sender = await User.findById(req.user.id).select('name username avatarUrl').lean();
    const payload = { conversationId: String(conversation._id), message: messageDto({ ...message.toObject(), senderId: sender }) };
    emitToUser(String(recipient._id), 'message:new', payload);
    res.status(201).json({ message: payload.message });
  })
);

export default router;
