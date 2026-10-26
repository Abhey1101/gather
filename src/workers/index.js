import { Worker } from 'bullmq';
import { createRedis } from '../config/redis.js';
import { logger } from '../config/logger.js';
import { processNotification } from '../services/notification.service.js';
import { fanoutPost, unfollowCleanup } from '../services/feed.service.js';

export function startWorkers() {
  const notifications = new Worker('notifications', (job) => processNotification(job.data), {
    connection: createRedis(),
    concurrency: 20,
  });
  const fanout = new Worker(
    'fanout',
    async (job) => {
      if (job.name === 'fanout-post') return fanoutPost(job.data.postId);
      if (job.name === 'unfollow-cleanup') return unfollowCleanup(job.data);
    },
    { connection: createRedis(), concurrency: 5 }
  );
  for (const w of [notifications, fanout]) {
    w.on('failed', (job, err) => logger.error({ queue: w.name, jobId: job?.id, err: err.message }, 'job failed'));
  }
  logger.info('Workers started: notifications, fanout');
  return [notifications, fanout];
}
