import type { D1Migration } from 'cloudflare:test';
import type { Env as ApiEnv } from '../src/env';

// The bindings the tests see: the Worker's own (wrangler.jsonc) plus the migrations
// vitest.config.ts reads and hands in.
declare global {
  namespace Cloudflare {
    interface Env extends ApiEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
