import { defineConfig } from 'vitest/config';

// Service-level tests of the D1 ports (ODY-296): a local D1 (Miniflare) with the committed
// baseline, the services called with a real `db`. Named *.vtest.ts (or under __tests__/d1/) so
// bun's own runner (`bun test`) keeps ignoring them.
export default defineConfig({
  test: {
    include: ['src/**/*.vtest.ts', 'src/**/__tests__/d1/**/*.test.ts'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    fileParallelism: false,
    setupFiles: ['./src/__tests__/helpers/setup-vtest.ts'],
    // Test values: nothing here is a credential.
    env: {
      APP_URL: 'http://localhost:3001',
      API_URL: 'http://localhost:3000',
      BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123456789',
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
  },
});
