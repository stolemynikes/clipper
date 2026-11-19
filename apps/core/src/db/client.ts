import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from '../env.ts';
import * as schema from './schema.ts';

export type Db = ReturnType<typeof openDb>;

/** Opens the SQLite DB (":memory:" for tests) and applies pending migrations. */
export function openDb(file = join(paths.dataDir, 'clipping.db')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: join(paths.coreDir, 'drizzle') });
  return db;
}
