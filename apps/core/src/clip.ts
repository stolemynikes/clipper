// npm run clip <twitch-vod-url>: queue one VOD (only for streamers with an active campaign).
import { openDb } from './db/client.ts';
import { addVodUrl } from './modules/watcher/watcher.ts';

const url = process.argv[2];
if (!url) { console.error('usage: npm run clip <twitch-vod-url>'); process.exit(1); }
try {
  console.log((await addVodUrl(openDb(), url)) ? `queued ${url}; run npm start to process` : `${url} was already queued`);
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
}
