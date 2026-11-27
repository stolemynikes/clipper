// node src/scripts/proof-render.ts <momentId> <proposalId...>: render proposals next to clip.mp4 on a kept window, for checking by eye.
// No DB change and no judge job; files land in data/clips/<momentId>.
import { openDb } from '../db/client.ts';
import { renderClip } from '../modules/editor/clip-job.ts';

const [id, ...proof] = process.argv.slice(2);
if (!id || !proof.length) { console.error('usage: node src/scripts/proof-render.ts <momentId> <proposalId...>'); process.exit(1); }
await renderClip(openDb(), { momentId: Number(id), proof });
