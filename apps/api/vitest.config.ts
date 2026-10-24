import { defineConfig } from 'vitest/config';

// D1 tests (ODY-296): services run against a Miniflare D1 + R2. The bun integration suites
// of the api (*.test.ts under __tests__/integration) keep running under `bun test`.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/d1/**/*.test.ts'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
