// A local D1 and R2 (Miniflare) carrying the committed baseline, for the *.vtest.ts suites of
// the worker. The worker functions are called with this `db`, so the raw SQL (UPDATE ...
// RETURNING claims, INSERT ... SELECT) runs against real D1 semantics: batches, one writer.
import { createDb, type Db } from '@repo/db';
import { useR2Bucket } from '@repo/storage';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll } from 'vitest';
import { migrateD1 } from '../../../../../packages/db/src/migrate';

export interface TestEnv {
  db: Db;
  bucket: R2Bucket;
  dispose(): Promise<void>;
}

export async function createTestEnv(): Promise<TestEnv> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'test-db' },
    r2Buckets: { BUCKET: 'test-bucket' },
  });
  const db = createDb((await mf.getD1Database('DB')) as unknown as D1Database);
  const bucket = (await mf.getR2Bucket('BUCKET')) as unknown as R2Bucket;
  useR2Bucket(bucket);
  await migrateD1(db);
  return { db, bucket, dispose: () => mf.dispose() };
}

// For a suite: `const t = useTestEnv();` then `t.db` inside tests (set once beforeAll ran).
export function useTestEnv(): { db: Db; bucket: R2Bucket } {
  const ctx = {} as { db: Db; bucket: R2Bucket };
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
    ctx.db = env.db;
    ctx.bucket = env.bucket;
  });
  afterAll(async () => {
    await env.dispose();
  });
  return ctx;
}
