/**
 * Before/after benchmark for GET /api/feed.
 *   RATE_LIMIT_DISABLED=true npm start          (in another terminal, after `npm run seed`)
 *   BENCH_EMAIL=user123@example.com npm run bench
 * 'mongo'  = pure fan-out-on-read ($in over followed authors, indexed)
 * 'hybrid' = Redis push-feed (+ celebrity pull) - the production path
 */
import autocannon from 'autocannon';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const EMAIL = process.env.BENCH_EMAIL || 'user1000@example.com';
const PASSWORD = process.env.BENCH_PASSWORD || 'Password123!';
const DURATION = Number(process.env.BENCH_SECONDS || 15);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS || 50);

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!login.ok) throw new Error(`Login failed (${login.status}). Did you run \`npm run seed\`?`);
const { accessToken } = await login.json();
const headers = { authorization: `Bearer ${accessToken}` };

// warm the Redis feed so 'hybrid' measures the steady state
await fetch(`${BASE}/api/feed?limit=10`, { headers });

const runs = [
  ['Mongo only (fan-out on read)', '/api/feed?limit=10&strategy=mongo'],
  ['Hybrid (Redis push + celeb pull)', '/api/feed?limit=10&strategy=hybrid'],
];
const rows = [];
for (const [name, path] of runs) {
  console.log(`Running: ${name} (${CONNECTIONS} connections, ${DURATION}s)...`);
  const r = await autocannon({ url: BASE + path, connections: CONNECTIONS, duration: DURATION, headers });
  rows.push({
    strategy: name, 'req/s': Math.round(r.requests.average), 'p50 ms': r.latency.p50, 'p95-ish (p97.5) ms': r.latency.p97_5,
    'p99 ms': r.latency.p99, errors: r.errors + r.non2xx,
  });
}
console.table(rows);
console.log('\nMarkdown for your README:\n');
console.log('| Strategy | req/s | p50 (ms) | p97.5 (ms) | p99 (ms) | errors |\n|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.strategy} | ${r['req/s']} | ${r['p50 ms']} | ${r['p95-ish (p97.5) ms']} | ${r['p99 ms']} | ${r.errors} |`);
