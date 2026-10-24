// Runs the committed baseline (drizzle-d1) on a local D1 (miniflare) and exercises three
// tables through the real client: user (better-auth), workspace/workspace_manager (app
// schema, via createWorkspace) and app_setting (the settings store).
import { eq } from 'drizzle-orm';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../client';
import { migrateD1 } from '../migrate';
import { appSetting, user, workspace, workspaceManager } from '../schema';
import { getOrCreateSetting, getSetting, setSetting } from '../settings';
import { createWorkspace, teamWorkspaceId } from '../workspace';

let mf: Miniflare;
let db: Db;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'test-db' },
  });
  db = createDb((await mf.getD1Database('DB')) as unknown as D1Database);
  await migrateD1(db);
});

afterAll(async () => {
  await mf.dispose();
});

describe('D1 baseline', () => {
  it('inserts and reads an auth user, with boolean and timestamp columns', async () => {
    await db.insert(user).values({ id: 'u1', name: 'Ada', email: 'ada@example.com' });
    const [row] = await db.select().from(user).where(eq(user.id, 'u1'));
    expect(row).toMatchObject({ name: 'Ada', emailVerified: false, role: 'user', active: true });
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(Math.abs(row!.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('creates a workspace and its owner in one batch', async () => {
    const id = await createWorkspace(db, 'Acme', 'u1');
    const [owner] = await db
      .select()
      .from(workspaceManager)
      .where(eq(workspaceManager.workspaceId, id));
    expect(owner).toMatchObject({ userId: 'u1', role: 'owner' });
    const [ws] = await db.select().from(workspace).where(eq(workspace.id, id));
    expect(ws!.name).toBe('Acme');
  });

  it('rejects an owner that is not a user (foreign keys are enforced)', async () => {
    await expect(createWorkspace(db, 'Ghost', 'nobody')).rejects.toThrow();
    const rows = await db.select().from(workspace).where(eq(workspace.name, 'Ghost'));
    expect(rows).toHaveLength(0); // the batch rolled the workspace back
  });

  it('stores JSON settings: first write wins, then overwritten and bumps updated_at', async () => {
    expect(await getSetting(db, 'k')).toBeNull();
    expect(await getOrCreateSetting(db, 'k', { a: 1 })).toEqual({ a: 1 });
    expect(await getOrCreateSetting(db, 'k', { a: 2 })).toEqual({ a: 1 });
    await setSetting(db, 'k', { a: 3, list: ['x', 'y'] });
    expect(await getSetting(db, 'k')).toEqual({ a: 3, list: ['x', 'y'] });
    const [row] = await db.select().from(appSetting).where(eq(appSetting.key, 'k'));
    expect(row!.updatedAt).toBeInstanceOf(Date);
  });

  it('teamWorkspaceId throws on an unknown team', async () => {
    await expect(teamWorkspaceId(999, db)).rejects.toThrow('does not exist');
  });
});
