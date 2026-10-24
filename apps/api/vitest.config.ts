import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// The api suite runs inside workerd (Miniflare) through @cloudflare/vitest-pool-workers: the
// app is imported by the tests, the D1 binding is the real one (a local database), and the
// baseline of packages/db is applied before each file (tests/setup.ts).
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, '../../packages/db/drizzle-d1'),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Test values: nothing here is a credential.
            BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123456789',
            APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
            APP_URL: 'http://localhost:3001',
            API_URL: 'http://localhost:3000',
          },
        },
      }),
    ],
    test: {
      include: ['src/**/*.vtest.ts', 'tests/**/*.test.ts'],
      setupFiles: ['./tests/setup.ts'],
      hookTimeout: 60_000,
      testTimeout: 30_000,
    },
  };
});
