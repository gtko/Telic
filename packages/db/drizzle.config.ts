import { defineConfig } from 'drizzle-kit';

// SPIKE S3 (ODY-296): sqlite dialect for Cloudflare D1. Migrations go to drizzle-d1/,
// applied to D1 by wrangler (see wrangler.jsonc). The pg schema and drizzle/ are untouched.
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle-d1',
  dialect: 'sqlite',
  verbose: true,
  strict: true,
});
