/**
 * Seeds a realistic, skewed social graph using raw bulk inserts.
 *   npm run seed                                  -> 20k users, ~30 follows each, ~10 posts each
 *   SEED_USERS=100000 SEED_POSTS_PER_USER=10 npm run seed   -> 100k users, ~1M posts
 *   npm run seed -- --reset                       -> drop the database first
 * Follow targets are drawn with a power-law skew, so a few accounts become "celebrities".
 * Login for any seeded user: user<N>@example.com / Password123!
 */
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectMongo } from '../src/config/db.js';
import { User } from '../src/models/User.js';
import { Follow } from '../src/models/Follow.js';
import { Post } from '../src/models/Post.js';

const N = Number(process.env.SEED_USERS || 20000);
const FOLLOWS = Number(process.env.SEED_FOLLOWS_PER_USER || 30);
const POSTS = Number(process.env.SEED_POSTS_PER_USER || 10);
const BATCH = 10000;
const TAGS = ['node', 'mern', 'backend', 'redis', 'mongodb', 'travel', 'food', 'music', 'fitness', 'art', 'coding', 'photography'];
const WORDS = ['sunrise', 'launch', 'weekend', 'coffee', 'shipping', 'bug', 'fix', 'deploy', 'idea', 'vibes', 'sprint', 'review'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const ObjectId = mongoose.Types.ObjectId;

async function insertBatched(Model, gen, total) {
  let buf = [];
  let done = 0;
  for (const doc of gen) {
    buf.push(doc);
    if (buf.length >= BATCH) {
      await Model.collection.insertMany(buf, { ordered: false });
      done += buf.length;
      buf = [];
      process.stdout.write(`\r  ${Model.modelName}: ${done}/${total}`);
    }
  }
  if (buf.length) {
    await Model.collection.insertMany(buf, { ordered: false });
    done += buf.length;
  }
  process.stdout.write(`\r  ${Model.modelName}: ${done}/${total}\n`);
}

await connectMongo();
if (process.argv.includes('--reset')) await mongoose.connection.dropDatabase();
await Promise.all([User.init(), Follow.init(), Post.init()]); // indexes first => inserts validate uniqueness

console.log(`Seeding ${N} users, ~${FOLLOWS} follows/user, ~${POSTS} posts/user`);
const passwordHash = await bcrypt.hash('Password123!', 8);
const ids = Array.from({ length: N }, () => new ObjectId());
const followers = new Int32Array(N);
const following = new Int32Array(N);

function* followGen() {
  for (let i = 0; i < N; i++) {
    const k = 1 + Math.floor(Math.random() * 2 * FOLLOWS);
    const targets = new Set();
    for (let j = 0; j < k; j++) {
      const t = Math.floor(N * Math.random() ** 3); // power-law skew toward low indexes
      if (t !== i) targets.add(t);
    }
    for (const t of targets) {
      followers[t]++;
      following[i]++;
      const at = new Date(Date.now() - Math.random() * 60 * 86400_000);
      yield { followerId: ids[i], followingId: ids[t], status: 'accepted', createdAt: at, updatedAt: at };
    }
  }
}
await insertBatched(Follow, followGen(), N * FOLLOWS);

function* userGen() {
  for (let i = 0; i < N; i++) {
    const now = new Date();
    yield {
      _id: ids[i], name: `User ${i}`, username: `user${i}`, email: `user${i}@example.com`, passwordHash,
      bio: '', isPrivate: false, followerCount: followers[i], followingCount: following[i], createdAt: now, updatedAt: now,
    };
  }
}
await insertBatched(User, userGen(), N);

function* postGen() {
  for (let i = 0; i < N; i++) {
    const k = 1 + Math.floor(Math.random() * 2 * POSTS);
    for (let j = 0; j < k; j++) {
      const tags = [pick(TAGS), pick(TAGS)];
      const at = new Date(Date.now() - Math.random() * 30 * 86400_000);
      yield {
        authorId: ids[i],
        caption: `${pick(WORDS)} ${pick(WORDS)} ${tags.map((t) => '#' + t).join(' ')}`,
        media: [], hashtags: [...new Set(tags)], likeCount: Math.floor(Math.random() * 50), commentCount: 0, createdAt: at, updatedAt: at,
      };
    }
  }
}
await insertBatched(Post, postGen(), N * POSTS);

let best = 0;
for (let i = 0; i < N; i++) if (following[i] > following[best] && followers[i] < 1000) best = i;
console.log(`\nDone. Top account: user0 has ${followers[0]} followers (set CELEB_THRESHOLD below this to exercise fan-out on read).`);
console.log(`Benchmark login: user${best}@example.com / Password123!  (follows ${following[best]} accounts)`);
await mongoose.disconnect();
