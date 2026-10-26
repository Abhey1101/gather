import { Emitter } from '@socket.io/redis-emitter';
import { createRedis } from './config/redis.js';

// The emitter publishes through Redis, so ANY process (API instance or worker)
// can push events to sockets connected to ANY API instance.
const emitter = new Emitter(createRedis());

export const emitToUser = (userId, event, payload) => emitter.to(`user:${userId}`).emit(event, payload);
export const emitToPost = (postId, event, payload) => emitter.to(`post:${postId}`).emit(event, payload);
