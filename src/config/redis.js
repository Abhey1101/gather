import Redis from 'ioredis';
import { env } from './env.js';

// BullMQ requires maxRetriesPerRequest: null on its connections.
export const createRedis = () => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
export const redis = createRedis();
