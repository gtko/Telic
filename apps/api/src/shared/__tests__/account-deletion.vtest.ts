import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { documentAsset, projectDocument, user } from '@repo/db';
import { createTestDb, seedProject, type TestDb } from '#tests/helpers/d1';

const deleted: string[][] = [];
vi.mock('@repo/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@repo/storage')>()),
  deleteObjects: async (keys: string[]) => void deleted.push(keys),
}));
// The workspace hand-over belongs to the teams module (ported by another lot).
vi.mock('#modules/teams/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#modules/teams/service')>()),
  releaseOwnedWorkspaces: async () => undefined,
}));

const { deleteAccount } = await import('../account-deletion');

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.dispose());

type NewDoc = typeof projectDocument.$inferInsert;
async function doc(projectId: number, ownerUserId: string, over: Partial<NewDoc> = {}) {
  const [row] = await t.db
    .insert(projectDocument)
    .values({ projectId, ownerUserId, title: 'd', ...over } as NewDoc)
    .returning({ id: projectDocument.id });
  return row!.id;
}

describe('deleteAccount', () => {
  it('detaches public pages, drops private ones with their assets, removes the account', async () => {
    const s = await seedProject(t.db, { key: 'DEL1', userId: 'del-user-1' });
    const priv = await doc(s.projectId, s.userId, { isPrivate: true });
    const pub = await doc(s.projectId, s.userId);
    const child = await doc(s.projectId, 'del-user-1', { parentId: priv });
    await t.db.insert(documentAsset).values({
      documentId: priv,
      s3Key: 'k/private.png',
      filename: 'private.png',
      contentType: 'image/png',
      sizeBytes: 1,
    } as typeof documentAsset.$inferInsert);
    deleted.length = 0;

    expect(await deleteAccount(t.db, s.userId)).toBe(true);

    expect(await t.db.select().from(user).where(eq(user.id, s.userId))).toHaveLength(0);
    expect(
      await t.db.select().from(projectDocument).where(eq(projectDocument.id, priv)),
    ).toHaveLength(0);
    const [p] = await t.db.select().from(projectDocument).where(eq(projectDocument.id, pub));
    expect(p!.ownerUserId).toBeNull();
    expect(p!.version).toBe(2);
    const [c] = await t.db.select().from(projectDocument).where(eq(projectDocument.id, child));
    expect(c!.parentId).toBeNull();
    expect(deleted.flat()).toEqual(['k/private.png']);
  });

  it('answers false for an account that does not exist', async () => {
    expect(await deleteAccount(t.db, 'nobody')).toBe(false);
  });

  it('leaves no page pointing at the account when pages are created during the deletion', async () => {
    const s = await seedProject(t.db, { key: 'DEL2', userId: 'del-user-2' });
    await doc(s.projectId, s.userId);
    const creates = Array.from({ length: 10 }, (_, i) =>
      doc(s.projectId, s.userId, { isPrivate: i % 2 === 0 }).catch(() => null),
    );
    const [ok] = await Promise.all([deleteAccount(t.db, s.userId), ...creates]);
    expect(ok).toBe(true);
    const rows = await t.db
      .select()
      .from(projectDocument)
      .where(eq(projectDocument.projectId, s.projectId));
    expect(rows.every((r) => r.ownerUserId === null && !r.isPrivate)).toBe(true);
  });

  it('answers true for exactly one of two simultaneous deletions', async () => {
    const s = await seedProject(t.db, { key: 'DEL3', userId: 'del-user-3' });
    const results = await Promise.all([
      deleteAccount(t.db, s.userId),
      deleteAccount(t.db, s.userId),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
