import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import excluded from './tests/porting-excluded.json' with { type: 'json' };

// Two projects (ODY-296):
//  - `workers`: the app run inside workerd through @cloudflare/vitest-pool-workers (tests/),
//    the D1 binding is the real one and the baseline of packages/db is applied per file.
//  - `node`: service-level tests of the D1 ports (src/**/*.vtest.ts, src/**/__tests__/d1/): a
//    Miniflare D1 started by the test itself, the services called with a real `db`. Named so
//    that bun's own runner (`bun run test:bun`) keeps ignoring them.
const testEnv = {
  // Test values: nothing here is a credential.
  BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123456789',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  APP_URL: 'http://localhost:3001',
  API_URL: 'http://localhost:3000',
};

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, '../../packages/db/drizzle-d1'),
  );
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              main: './tests/entry.ts',
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations, ...testEnv } },
            }),
          ],
          test: {
            name: 'workers',
            include: ['tests/**/*.test.ts'],
            // Ported but not yet green: listed in docs/PORTING_TESTS_TODO.md.
            exclude: excluded,
            setupFiles: ['./tests/setup.ts'],
            hookTimeout: 60_000,
            testTimeout: 30_000,
          },
        },
        {
          resolve: {
            alias: {
              'cloudflare:workers': path.join(
                import.meta.dirname,
                'src/__tests__/helpers/cloudflare-workers.ts',
              ),
            },
          },
          test: {
            name: 'node',
            include: ['src/**/*.vtest.ts', 'src/**/__tests__/d1/**/*.test.ts'],
            hookTimeout: 60_000,
            testTimeout: 60_000,
            fileParallelism: false,
            env: testEnv,
          },
        },
      ],
    },
  };
});
