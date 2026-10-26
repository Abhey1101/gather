import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import mongoose from 'mongoose';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { redis } from './config/redis.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFound } from './middleware/error.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import followRequestRoutes from './routes/followRequests.js';
import postRoutes from './routes/posts.js';
import feedRoutes from './routes/feed.js';
import notificationRoutes from './routes/notifications.js';
import exploreRoutes, { searchRouter } from './routes/explore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: { imgSrc: ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'] } } }));
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', async (req, res) => {
    const mongo = mongoose.connection.readyState === 1;
    const redisOk = (await redis.ping().catch(() => null)) === 'PONG';
    res.status(mongo && redisOk ? 200 : 503).json({ status: mongo && redisOk ? 'ok' : 'degraded', mongo, redis: redisOk, instance: env.INSTANCE_ID || process.pid });
  });

  app.use('/uploads', express.static(path.join(__dirname, '../data/uploads'), { fallthrough: false, maxAge: '1d' }));
  app.use(express.static(path.join(__dirname, '../public'))); // demo page at /demo.html
  const spec = YAML.parse(fs.readFileSync(path.join(__dirname, '../openapi.yaml'), 'utf8'));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));

  app.use('/api', globalLimiter);
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/follow-requests', followRequestRoutes);
  app.use('/api/posts', postRoutes);
  app.use('/api/feed', feedRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/explore', exploreRoutes);
  app.use('/api/search', searchRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
