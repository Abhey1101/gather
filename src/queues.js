import { Queue } from 'bullmq';
import { createRedis } from './config/redis.js';

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

export const notificationQueue = new Queue('notifications', { connection: createRedis(), defaultJobOptions });
export const fanoutQueue = new Queue('fanout', { connection: createRedis(), defaultJobOptions });

/** Fire-and-forget: the HTTP request never waits for notification delivery. */
export const enqueueNotification = (data) => notificationQueue.add('notify', data);
