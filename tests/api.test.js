import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://localhost:27017/socialfeed_test';
process.env.REDIS_URL ||= 'redis://localhost:6379/1'; // db 1: flushed by the tests
process.env.CELEB_THRESHOLD = '10000';

const { default: request } = await import('supertest');
const { default: mongoose } = await import('mongoose');
const { createApp } = await import('../src/app.js');
const { connectMongo } = await import('../src/config/db.js');
const { redis } = await import('../src/config/redis.js');
const { startWorkers } = await import('../src/workers/index.js');

const app = createApp();
let workers;
const users = {};
const auth = (u) => ({ authorization: `Bearer ${users[u].accessToken}` });
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for condition');
};

before(async () => {
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await mongoose.syncIndexes();
  await redis.flushdb();
  workers = startWorkers();
  for (const name of ['alice', 'bob', 'carol']) {
    const res = await request(app).post('/api/auth/register').send({
      name, username: name, email: `${name}@test.dev`, password: 'Password123!',
    });
    assert.equal(res.status, 201);
    users[name] = { ...res.body.user, ...res.body };
  }
});

after(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await mongoose.disconnect();
  redis.disconnect();
});

test('duplicate registration is rejected', async () => {
  const res = await request(app).post('/api/auth/register').send({ name: 'x', username: 'alice', email: 'other@test.dev', password: 'Password123!' });
  assert.equal(res.status, 409);
});

test('profile details can be updated while email stays private', async () => {
  const registration = await request(app).post('/api/auth/register').send({
    name: 'profile owner', username: 'profile_owner', email: 'profile-owner@test.dev', password: 'Password123!',
  });
  assert.equal(registration.status, 201);
  const token = { authorization: `Bearer ${registration.body.accessToken}` };
  const updated = await request(app).patch('/api/users/me').set(token).send({
    name: 'Updated Owner', username: 'updated_owner', email: 'updated-owner@test.dev',
    avatarUrl: 'https://example.com/avatar.png', bio: 'A new bio', website: 'https://example.com',
    birthday: '2000-01-02', pronouns: 'they/them', gender: 'nonbinary', isPrivate: true,
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.user.name, 'Updated Owner');
  assert.equal(updated.body.user.username, 'updated_owner');
  assert.equal(updated.body.user.email, 'updated-owner@test.dev');
  assert.equal(updated.body.user.avatarUrl, 'https://example.com/avatar.png');
  assert.equal(updated.body.user.bio, 'A new bio');
  assert.equal(updated.body.user.website, 'https://example.com');
  assert.equal(updated.body.user.birthday, '2000-01-02');
  assert.equal(updated.body.user.pronouns, 'they/them');
  assert.equal(updated.body.user.gender, 'nonbinary');
  assert.equal(updated.body.user.isPrivate, true);

  const ownProfile = await request(app).get('/api/users/me').set(token);
  assert.equal(ownProfile.body.user.birthday, '2000-01-02');
  const publicProfile = await request(app).get('/api/users/updated_owner').set(auth('alice'));
  assert.equal(publicProfile.status, 200);
  assert.equal(Object.hasOwn(publicProfile.body.user, 'email'), false);
  assert.equal(Object.hasOwn(publicProfile.body.user, 'birthday'), false);
  assert.equal(publicProfile.body.user.website, 'https://example.com');
  assert.equal(publicProfile.body.user.pronouns, 'they/them');
  assert.equal(publicProfile.body.user.gender, 'nonbinary');
  const conflict = await request(app).patch('/api/users/me').set(token).send({ email: 'alice@test.dev' });
  assert.equal(conflict.status, 409);
  const invalidBirthday = await request(app).patch('/api/users/me').set(token).send({ birthday: '2025-02-30' });
  assert.equal(invalidBirthday.status, 400);
  const invalidWebsite = await request(app).patch('/api/users/me').set(token).send({ website: 'javascript:alert(1)' });
  assert.equal(invalidWebsite.status, 400);
});

test('photo posts use local storage when Cloudinary is not configured', async () => {
  const configuredCloudinary = process.env.CLOUDINARY_URL;
  delete process.env.CLOUDINARY_URL;
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2ioAAAAASUVORK5CYII=', 'base64');
  let imagePath;
  try {
    const res = await request(app)
      .post('/api/posts')
      .set(auth('alice'))
      .field('caption', 'A locally uploaded photo')
      .attach('images', image, { filename: 'photo.png', contentType: 'image/png' });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    const url = res.body.post.media[0].url;
    assert.match(url, /^\/uploads\/[a-f0-9-]+\.png$/);
    imagePath = path.resolve('data/uploads', path.basename(url));
    const served = await request(app).get(url);
    assert.equal(served.status, 200);
    assert.deepEqual(served.body, image);
  } finally {
    if (configuredCloudinary) process.env.CLOUDINARY_URL = configuredCloudinary;
    else delete process.env.CLOUDINARY_URL;
    if (imagePath) await unlink(imagePath);
  }
});

test('refresh tokens rotate and reuse revokes the session', async () => {
  const login = await request(app).post('/api/auth/login').send({ email: 'carol@test.dev', password: 'Password123!' });
  const first = login.body.refreshToken;
  const rotated = await request(app).post('/api/auth/refresh').send({ refreshToken: first });
  assert.equal(rotated.status, 200);
  const reuse = await request(app).post('/api/auth/refresh').send({ refreshToken: first });
  assert.equal(reuse.status, 401);
  const afterRevoke = await request(app).post('/api/auth/refresh').send({ refreshToken: rotated.body.refreshToken });
  assert.equal(afterRevoke.status, 401, 'reuse must revoke every session of that user');
});

test('follow is idempotent and counters stay correct', async () => {
  const a = await request(app).post(`/api/users/${users.alice.id}/follow`).set(auth('bob'));
  const b = await request(app).post(`/api/users/${users.alice.id}/follow`).set(auth('bob'));
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.changed, false);
  const profile = await request(app).get('/api/users/alice').set(auth('bob'));
  assert.equal(profile.body.user.followerCount, 1);
  assert.equal(profile.body.relationship, 'accepted');
});

test('feed paginates with a compound cursor: no gaps, no duplicates, newest first', async () => {
  const created = [];
  for (let i = 0; i < 25; i++) {
    const r = await request(app).post('/api/posts').set(auth('alice')).send({ caption: `post ${i} #test` });
    assert.equal(r.status, 201);
    created.push(r.body.post._id);
  }
  // fan-out happens in the BullMQ worker; wait for it
  await until(async () => (await redis.zcard(`feed:${users.bob.id}`)) >= 25);

  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const res = await request(app).get('/api/feed').query({ limit: 10, ...(cursor && { cursor }) }).set(auth('bob'));
    assert.equal(res.status, 200);
    seen.push(...res.body.items.map((p) => p._id));
    cursor = res.body.nextCursor;
    pages++;
  } while (cursor && pages < 10);

  assert.equal(pages, 3);
  assert.equal(new Set(seen).size, 25, 'no duplicates');
  assert.deepEqual([...seen].sort(), [...created].sort(), 'no gaps');
  assert.deepEqual(seen, [...created].reverse(), 'newest first');

  const mongoFeed = await request(app).get('/api/feed').query({ limit: 25, strategy: 'mongo' }).set(auth('bob'));
  assert.deepEqual(mongoFeed.body.items.map((p) => p._id), seen, 'both strategies agree');
});

test('invalid cursor is a 400', async () => {
  const res = await request(app).get('/api/feed').query({ cursor: 'garbage' }).set(auth('bob'));
  assert.equal(res.status, 400);
});

test('like/unlike are idempotent', async () => {
  const feed = await request(app).get('/api/feed').query({ limit: 1 }).set(auth('bob'));
  const id = feed.body.items[0]._id;
  const l1 = await request(app).post(`/api/posts/${id}/like`).set(auth('bob'));
  const l2 = await request(app).post(`/api/posts/${id}/like`).set(auth('bob'));
  assert.equal(l1.body.likeCount, 1);
  assert.equal(l2.body.likeCount, 1);
  assert.equal(l2.body.changed, false);
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => request(app).post(`/api/posts/${id}/like`).set(auth('carol'))));
  assert.ok(concurrent.every((r) => r.status === 200));
  const post = await request(app).get(`/api/posts/${id}`).set(auth('bob'));
  assert.equal(post.body.post.likeCount, 2, 'five concurrent likes from one user count once');
  const u1 = await request(app).delete(`/api/posts/${id}/like`).set(auth('bob'));
  const u2 = await request(app).delete(`/api/posts/${id}/like`).set(auth('bob'));
  assert.equal(u1.body.likeCount, 1);
  assert.equal(u2.body.likeCount, 1);
});

test('notifications aggregate per post and unread count tracks documents', async () => {
  const feed = await request(app).get('/api/feed').query({ limit: 1 }).set(auth('carol'));
  // carol is not following alice, so use alice's own profile grid to get a post id
  const grid = await request(app).get('/api/users/alice/posts').query({ limit: 2 }).set(auth('carol'));
  const id = grid.body.items[1]._id;
  assert.ok(feed.status === 200);
  await request(app).post(`/api/posts/${id}/like`).set(auth('bob'));
  await request(app).post(`/api/posts/${id}/like`).set(auth('carol'));

  const note = await until(async () => {
    const r = await request(app).get('/api/notifications').set(auth('alice'));
    return r.body.items.find((n) => n.type === 'like' && n.entityId === id && n.actorCount === 2);
  });
  assert.equal(note.actors.length, 2);
  const count = await request(app).get('/api/notifications/unread-count').set(auth('alice'));
  assert.ok(count.body.unreadCount >= 1);

  await request(app).patch('/api/notifications/read-all').set(auth('alice'));
  const zero = await request(app).get('/api/notifications/unread-count').set(auth('alice'));
  assert.equal(zero.body.unreadCount, 0);
});

test('private accounts require an accepted follow request', async () => {
  await request(app).patch('/api/users/me').set(auth('carol')).send({ isPrivate: true });
  const res = await request(app).post(`/api/users/${users.carol.id}/follow`).set(auth('bob'));
  assert.equal(res.body.status, 'pending');
  const denied = await request(app).get('/api/users/carol/posts').set(auth('bob'));
  assert.equal(denied.status, 403);

  const pending = await request(app).get('/api/follow-requests').set(auth('carol'));
  const reqId = pending.body.requests[0].id;
  const [a, b] = await Promise.all([
    request(app).patch(`/api/follow-requests/${reqId}/accept`).set(auth('carol')),
    request(app).patch(`/api/follow-requests/${reqId}/accept`).set(auth('carol')),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 404], 'exactly one concurrent accept wins');
  const profile = await request(app).get('/api/users/carol').set(auth('carol'));
  assert.equal(profile.body.user.followerCount, 1, 'counter incremented exactly once');
  const ok = await request(app).get('/api/users/carol/posts').set(auth('bob'));
  assert.equal(ok.status, 200);
});
