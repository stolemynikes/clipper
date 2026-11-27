// node src/scripts/redo-render.ts <momentId...>: render reviewed moments again into their existing clip rows, then judge + review as usual.
import { openDb } from '../db/client.ts';
import { renderClip } from '../modules/editor/clip-job.ts';

const ids = process.argv.slice(2).map(Number);
if (!ids.length || ids.some((n) => !n)) { console.error('usage: node src/scripts/redo-render.ts <momentId...>'); process.exit(1); }
const db = openDb();
for (const momentId of ids) await renderClip(db, { momentId, redo: true });
