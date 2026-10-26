import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redis } from '../config/redis.js';
import { env } from '../config/env.js';

// Redis-backed => limits are shared across every API instance.
const make = (prefix, windowMs, limit) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.NODE_ENV === 'test' || env.RATE_LIMIT_DISABLED,
    keyGenerator: (req) => req.user?.id ?? req.ip,
    store: new RedisStore({ prefix: `rl:${prefix}:`, sendCommand: (...args) => redis.call(...args) }),
    message: { error: 'Too many requests, slow down.' },
  });

export const globalLimiter = make('global', 60_000, 300);
export const authLimiter = make('auth', 15 * 60_000, 30); // brute-force protection
export const writeLimiter = make('write', 60_000, 60); // post / like / follow / comment
