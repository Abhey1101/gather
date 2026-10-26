import http from 'node:http';
import mongoose from 'mongoose';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectMongo } from './config/db.js';
import { redis } from './config/redis.js';
import { createApp } from './app.js';
import { attachSocket } from './sockets/index.js';
import { startWorkers } from './workers/index.js';

await connectMongo();
await mongoose.syncIndexes(); // make sure unique/partial indexes exist before taking traffic

const server = http.createServer(createApp());
attachSocket(server);
const workers = env.RUN_WORKER ? startWorkers() : [];

server.listen(env.PORT, () => logger.info(`API listening on :${env.PORT} (instance ${env.INSTANCE_ID || process.pid})`));

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);
  server.close();
  await Promise.all(workers.map((w) => w.close()));
  await mongoose.disconnect();
  redis.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
