import { defineConfig } from 'drizzle-kit';

// One dialect: sqlite, for Cloudflare D1. Migrations go to drizzle-d1/ and are applied by
// `wrangler d1 migrations apply` (see wrangler.jsonc). The Postgres-era migrations live in
// legacy-pg/ and are never run: they only document the data the migration script has to move.
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle-d1',
  dialect: 'sqlite',
  verbose: true,
  strict: true,
});
