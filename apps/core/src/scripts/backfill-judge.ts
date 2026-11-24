// One-off: add laugh/cheer + LLM judge to clips rendered before the judge existed. No review push.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb } from '../db/client.ts';
import { clips } from '../db/schema.ts';
import { paths } from '../env.ts';
import { judgeClip } from '../modules/judge/judge.ts';
import { runCmd } from '../proc.ts';

const db = openDb();
for (const c of db.select().from(clips).all()) {
  const comp = (c.compliance ?? {}) as { music?: Record<string, unknown> };
  if (existsSync(c.filePath) && comp.music?.laughRatio === undefined) {
    const m = JSON.parse(await runCmd(paths.pythonBin, [join(paths.rootDir, 'workers', 'music_detect.py'), JSON.stringify({ input: c.filePath })]));
    db.update(clips).set({ compliance: { ...comp, music: { ...comp.music, laughRatio: m.laughRatio, cheerRatio: m.cheerRatio } } as typeof c.compliance }).where(eq(clips.id, c.id)).run();
  }
  await judgeClip(db, { clipId: c.id, notify: false });
}
