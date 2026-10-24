import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/d1/migrator';
import { Miniflare } from 'miniflare';
import { createDb, type Db, user, userTelegramAccount } from '@repo/db';

// A fresh local D1 for each test file, built from the committed baseline that the api
// migrates in production (packages/db/drizzle-d1). Miniflare serves it in-process: no
// Cloudflare account and no remote database are involved.
const migrationsFolder = fileURLToPath(new URL('../../../packages/db/drizzle-d1', import.meta.url));

export interface TestD1 {
  db: Db;
  binding: D1Database;
  dispose: () => Promise<void>;
}

export async function createTestD1(): Promise<TestD1> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'test-db' },
  });
  const binding = (await mf.getD1Database('DB')) as unknown as D1Database;
  const db = createDb(binding);
  await migrate(db, { migrationsFolder });
  return { db, binding, dispose: () => mf.dispose() };
}

// A user with a link code the api would have minted: the pending row `/start` redeems.
export async function insertPendingLink(
  db: Db,
  ttlMinutes = 15,
): Promise<{ userId: string; code: string }> {
  const userId = randomUUID();
  await db.insert(user).values({ id: userId, name: 'Linker', email: `${userId}@example.test` });
  const code = randomUUID();
  await db.insert(userTelegramAccount).values({
    userId,
    linkCode: code,
    linkCodeExpiresAt: new Date(Date.now() + ttlMinutes * 60_000),
  });
  return { userId, code };
}
