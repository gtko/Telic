// Applies the committed migrations of ./drizzle-d1 to a D1 binding from Node: the local
// database of the tests and of a script, through a miniflare or `getPlatformProxy` binding.
// Not exported from the package index. Deployed databases are migrated with
// `wrangler d1 migrations apply`, which does the locking and the bookkeeping itself, so
// there is no advisory lock, no pre-migration dump (D1 Time Travel covers restores) and no
// wait-for-migrations step here.
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/d1/migrator';
import type { Db } from './client';

export const migrationsFolder = fileURLToPath(new URL('../drizzle-d1', import.meta.url));

export async function migrateD1(db: Db, folder = migrationsFolder): Promise<void> {
  await migrate(db, { migrationsFolder: folder });
}
