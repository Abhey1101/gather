import { Router } from 'express';
import { Follow } from '../models/Follow.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ApiError } from '../utils/errors.js';
import { idParam } from '../utils/schemas.js';
import { onFollowAccepted } from '../services/follow.service.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const requests = await Follow.find({ followingId: req.user.id, status: 'pending' })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('followerId', 'username name avatarUrl')
      .lean();
    res.json({ requests: requests.map((r) => ({ id: r._id, user: r.followerId, createdAt: r.createdAt })) });
  })
);

// The pending -> accepted transition is a single atomic conditional update: if two accepts race
// (double click, retry) exactly one wins and counters are incremented exactly once. No multi-document
// transaction (and therefore no replica set) is needed.
router.patch(
  '/:id/accept',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const follow = await Follow.findOneAndUpdate(
      { _id: req.params.id, followingId: req.user.id, status: 'pending' },
      { $set: { status: 'accepted' } },
      { new: true }
    );
    if (!follow) throw new ApiError(404, 'Request not found or already handled');
    await onFollowAccepted(follow.followerId, req.user.id);
    res.json({ status: 'accepted' });
  })
);

router.patch(
  '/:id/reject',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const deleted = await Follow.findOneAndDelete({ _id: req.params.id, followingId: req.user.id, status: 'pending' });
    if (!deleted) throw new ApiError(404, 'Request not found or already handled');
    res.json({ status: 'rejected' });
  })
);

export default router;
