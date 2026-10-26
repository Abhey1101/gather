import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import jwt from 'jsonwebtoken';
import { createRedis } from '../config/redis.js';
import { env } from '../config/env.js';

const isId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);

export function attachSocket(httpServer) {
  const pub = createRedis();
  const sub = pub.duplicate();
  const io = new Server(httpServer, { cors: { origin: env.CORS_ORIGIN } });
  io.adapter(createAdapter(pub, sub)); // sockets on instance A can receive events published from instance B / the worker

  io.use((socket, next) => {
    try {
      const payload = jwt.verify(socket.handshake.auth?.token, env.JWT_ACCESS_SECRET);
      socket.userId = payload.sub;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.userId}`);
    socket.on('post:watch', (id) => isId(id) && socket.join(`post:${id}`)); // live like/comment counts
    socket.on('post:unwatch', (id) => isId(id) && socket.leave(`post:${id}`));
    socket.emit('ready', { instance: env.INSTANCE_ID || String(process.pid) });
  });
  return io;
}
