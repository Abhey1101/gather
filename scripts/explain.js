/** Proves the indexes are used: prints plan stages + docs examined for the hot queries. */
import mongoose from 'mongoose';
import { connectMongo } from '../src/config/db.js';
import { Post } from '../src/models/Post.js';
import { Follow } from '../src/models/Follow.js';
import { Notification } from '../src/models/Notification.js';

const stages = (plan, out = []) => {
  if (!plan || typeof plan !== 'object') return out;
  if (plan.stage) out.push(plan.indexName ? `${plan.stage}(${plan.indexName})` : plan.stage);
  for (const key of ['inputStage', 'inputStages', 'queryPlan']) {
    const v = plan[key];
    if (Array.isArray(v)) v.forEach((p) => stages(p, out));
    else if (v) stages(v, out);
  }
  return out;
};

async function report(title, cursor) {
  const e = await cursor.explain('executionStats');
  const s = e.executionStats;
  console.log(`\n== ${title}`);
  console.log('plan:           ', stages(e.queryPlanner.winningPlan).join(' <- '));
  console.log('docs returned:  ', s.nReturned);
  console.log('keys examined:  ', s.totalKeysExamined);
  console.log('docs examined:  ', s.totalDocsExamined);
  console.log('execution ms:   ', s.executionTimeMillis);
  if (stages(e.queryPlanner.winningPlan).includes('COLLSCAN')) console.log('!! COLLSCAN - missing index');
}

await connectMongo();
const sample = await Follow.findOne().lean();
if (!sample) throw new Error('No data. Run `npm run seed` first.');
const followed = (await Follow.find({ followerId: sample.followerId }).select('followingId').lean()).map((f) => f.followingId);

await report('Feed (fan-out on read): posts by followed authors, newest first',
  Post.find({ authorId: { $in: followed } }).sort({ createdAt: -1, _id: -1 }).limit(11).select('_id createdAt'));
await report('Fan-out: followers of an author', Follow.find({ followingId: sample.followingId, status: 'accepted' }).select('followerId'));
await report('Following list', Follow.find({ followerId: sample.followerId, status: 'accepted' }).select('followingId'));
await report('Hashtag page', Post.find({ hashtags: 'node' }).sort({ createdAt: -1 }).limit(20));
await report('Notifications list', Notification.find({ userId: sample.followerId }).sort({ updatedAt: -1, _id: -1 }).limit(11));
await mongoose.disconnect();
