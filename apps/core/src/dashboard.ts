// Dashboard only: serves the review/dashboard server without workers, timers or Discord.
// Buttons that queue jobs (scan, join, publish) wait until `npm start` runs again.
import { openDb } from './db/client.ts';
import { startReviewServer } from './review/server.ts';

const server = startReviewServer(openDb());
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close());
