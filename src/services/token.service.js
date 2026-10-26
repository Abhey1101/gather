import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { redis } from '../config/redis.js';
import { ApiError } from '../utils/errors.js';

const setKey = (userId) => `rtset:${userId}`;
const ttlSec = env.REFRESH_TTL_DAYS * 86400;

export async function issueTokens(userId) {
  userId = String(userId);
  const accessToken = jwt.sign({ sub: userId }, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TTL });
  const jti = crypto.randomUUID();
  const refreshToken = jwt.sign({ sub: userId, jti }, env.JWT_REFRESH_SECRET, { expiresIn: ttlSec });
  await redis.multi().sadd(setKey(userId), jti).expire(setKey(userId), ttlSec).exec();
  return { accessToken, refreshToken };
}

/**
 * Refresh-token rotation with reuse detection: every refresh token is single-use.
 * Presenting one that was already used means it was likely stolen => revoke ALL sessions.
 */
export async function rotateTokens(refreshToken) {
  let payload;
  try {
    payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET);
  } catch {
    throw new ApiError(401, 'Invalid refresh token');
  }
  const removed = await redis.srem(setKey(payload.sub), payload.jti);
  if (!removed) {
    await redis.del(setKey(payload.sub));
    throw new ApiError(401, 'Refresh token reuse detected; all sessions revoked');
  }
  return { userId: payload.sub, ...(await issueTokens(payload.sub)) };
}

export async function revokeToken(refreshToken) {
  try {
    const p = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET);
    await redis.srem(setKey(p.sub), p.jti);
  } catch {
    /* already invalid: nothing to revoke */
  }
}
