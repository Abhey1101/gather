// Standalone worker process: `npm run worker` (set RUN_WORKER=false on the API instances).
import { connectMongo } from './config/db.js';
import { startWorkers } from './workers/index.js';

await connectMongo();
const workers = startWorkers();
const shutdown = async () => {
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
