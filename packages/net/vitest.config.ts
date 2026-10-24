import { defineConfig } from 'vitest/config';

// The pinned-fetch tests reach real public hosts over DNS-over-HTTPS, so the timeouts
// are longer than vitest's defaults.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], testTimeout: 30_000 },
});
