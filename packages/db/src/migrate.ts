// Applies the committed migrations of ./drizzle-d1 to a D1 binding from Node: the local
// database of the tests and of a script, through a miniflare or `getPlatformProxy` binding.
// Not exported from the package index. Deployed databases are migrated with
// `wrangler d1 migrations apply`, which does the locking and the bookkeeping itself, so
// there is no advisory lock, no pre-migration dump (D1 Time Travel covers restores) and no
// wait-for-migrations step here.
//
// NEVER mix the two on one database. This helper records applied migrations in drizzle's
// __drizzle_migrations table (by hash); `wrangler d1 migrations apply` records them in
// d1_migrations (by file name). Each ignores the other's table, so running both on the same
// database replays 0000_baseline.sql and fails on "table already exists". A deployed D1 is
// only ever migrated by wrangler; migrateD1 is for throwaway local databases (tests, scripts).
// The journal in drizzle-d1/meta lists the hand-written 0001_triggers and 0002_seed too, so both
// tools run the same files in the same order.
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/d1/migrator';
import type { Db } from './client';

export const migrationsFolder = fileURLToPath(new URL('../drizzle-d1', import.meta.url));

export async function migrateD1(db: Db, folder = migrationsFolder): Promise<void> {
  await migrate(db, { migrationsFolder: folder });
}
