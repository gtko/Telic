// The per-request factory and the personal workspace, run on a local D1 (miniflare) with the
// committed baseline of @repo/db. The workspace guard is a batch of INSERT ... SELECT, so the
// race test below is the one that fails when that guard is removed.
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/d1/migrator';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createWorkspace, type Db } from '@repo/db';
import * as schema from '@repo/db/schema';
import { createAuth, ensurePersonalWorkspace, getSessionFromHeaders, type AuthEnv } from '../index';
import { setAuthSettings } from '../instance';

const migrationsFolder = fileURLToPath(new URL('../../../db/drizzle-d1', import.meta.url));
const env: AuthEnv = {
  APP_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:8787',
  BETTER_AUTH_SECRET: 'test-secret-with-more-than-thirty-two-chars',
};

let mf: Miniflare;
let db: Db;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'auth-test-db' },
  });
  db = createDb((await mf.getD1Database('DB')) as unknown as D1Database);
  await migrate(db, { migrationsFolder });
});

afterAll(async () => {
  await mf.dispose();
});

describe('createAuth', () => {
  it('refuses to build without APP_URL', () => {
    expect(() => createAuth({ ...env, APP_URL: undefined }, db)).toThrow('APP_URL is not set');
  });

  it('builds an instance over the given database and answers "no session" without a cookie', async () => {
    const auth = createAuth(env, db);
    expect(await getSessionFromHeaders(auth, new Headers())).toBeNull();
  });
});

describe('ensurePersonalWorkspace', () => {
  it('gives an account one owned workspace however many sign-ins race', async () => {
    await db
      .insert(schema.user)
      .values({ id: 'race', name: 'Race Person', email: 'race@example.com' });
    await Promise.all(
      Array.from({ length: 5 }, () => ensurePersonalWorkspace(db, { id: 'race', role: 'user' })),
    );
    const owned = await db
      .select()
      .from(schema.workspaceManager)
      .where(eq(schema.workspaceManager.userId, 'race'));
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ role: 'owner' });
    const [ws] = await db
      .select()
      .from(schema.workspace)
      .where(eq(schema.workspace.id, owned[0]!.workspaceId));
    expect(ws!.name).toBe('Race Person');
  });

  it('gives no second workspace to an account that already owns one', async () => {
    await db.insert(schema.user).values({ id: 'owner', name: 'Owner', email: 'owner@example.com' });
    await createWorkspace(db, 'Existing', 'owner');
    await ensurePersonalWorkspace(db, { id: 'owner', role: 'user' });
    const owned = await db
      .select()
      .from(schema.workspaceManager)
      .where(eq(schema.workspaceManager.userId, 'owner'));
    expect(owned).toHaveLength(1);
  });

  it('gives a plain account none while personal workspaces are off, and the instance owner one anyway', async () => {
    await setAuthSettings(db, { personalWorkspaces: false });
    await db.insert(schema.user).values({ id: 'plain', name: 'Plain', email: 'plain@example.com' });
    await db.insert(schema.user).values({ id: 'god', name: 'God', email: 'god@example.com' });
    await ensurePersonalWorkspace(db, { id: 'plain', role: 'user' });
    await ensurePersonalWorkspace(db, { id: 'god', role: 'god' });
    const plain = await db
      .select()
      .from(schema.workspaceManager)
      .where(eq(schema.workspaceManager.userId, 'plain'));
    const god = await db
      .select()
      .from(schema.workspaceManager)
      .where(eq(schema.workspaceManager.userId, 'god'));
    expect(plain).toHaveLength(0);
    expect(god).toHaveLength(1);
  });
});
