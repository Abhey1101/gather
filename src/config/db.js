import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

export async function connectMongo() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGO_URI, { maxPoolSize: 50 });
  logger.info('MongoDB connected');
}
