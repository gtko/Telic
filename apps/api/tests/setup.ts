import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';

// The baseline of packages/db (drizzle-d1), applied once per test file on a local D1.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage is not isolated per test in this plugin version, so every table is emptied before
// each test (the API suite did the same for Postgres). Foreign keys are deferred to the end of
// the batch so the order of the deletes does not matter. D1's own `_cf_*` tables are read-only.
beforeEach(async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name != 'd1_migrations'",
  ).all<{ name: string }>();
  await env.DB.batch([
    env.DB.prepare('PRAGMA defer_foreign_keys = ON'),
    ...results.map(({ name }) => env.DB.prepare(`DELETE FROM "${name}"`)),
  ]);
});
