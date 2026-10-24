import { defineConfig } from 'vitest/config';

// Two projects (ODY-296):
//  - `unit`: pure tests (src/**/*.test.ts).
//  - `d1`: the worker's SQL run against a Miniflare D1/R2 that each suite starts itself
//    (src/**/*.vtest.ts). Named so that bun's own runner ignores them.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          hookTimeout: 60_000,
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'd1',
          include: ['src/**/*.vtest.ts'],
          hookTimeout: 60_000,
          testTimeout: 60_000,
          fileParallelism: false,
          env: { APP_ENCRYPTION_KEY: 'dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdA==' },
        },
      },
    ],
  },
});
