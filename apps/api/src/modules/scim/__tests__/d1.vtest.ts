import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { projectMember, scimGroupMapping, scimGroupMember, user, type Db } from '@repo/db';
import { createTestDb, seedProject, type TestDb } from '#tests/helpers/d1';

vi.mock('@repo/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@repo/auth')>()),
  workspacesWithOwnScim: async () => [],
}));
vi.mock('#shared/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#shared/limits')>()),
  getLimits: async () => ({ maxSeats: 0 }),
}));
vi.mock('#modules/teams/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#modules/teams/service')>()),
  listSeatHolderIds: async () => [],
}));

const { QueryBudget, reconcileProjects, resumeReconcile, pendingReconcileProjects } =
  await import('../reconcile');
const { createScimGroup } = await import('../service');

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.dispose());

async function seedGroupGrant(db: Db, key: string, members: number) {
  const s = await seedProject(db, { key, userId: `scim-owner-${key}` });
  const group = await createScimGroup(db, null, {
    displayName: `group-${key}`,
    externalId: null,
    members: [],
  });
  const ids = Array.from({ length: members }, (_, i) => `scim-${key}-${i}`);
  await db.insert(user).values(ids.map((id) => ({ id, name: id, email: `${id}@example.com` })));
  await db.insert(scimGroupMember).values(ids.map((userId) => ({ groupId: group.id, userId })));
  await db
    .insert(scimGroupMapping)
    .values({ groupId: group.id, projectId: s.projectId, role: 'member', roleId: null });
  return { ...s, ids };
}

describe('reconcileProjects', () => {
  it('finishes a small reconciliation within the budget and parks nothing', async () => {
    const s = await seedGroupGrant(t.db, 'SC1', 3);
    expect(await reconcileProjects(t.db, [s.projectId])).toBe(true);
    expect(await pendingReconcileProjects(t.db)).toEqual([]);
    const rows = await t.db
      .select()
      .from(projectMember)
      .where(eq(projectMember.projectId, s.projectId));
    expect(rows.filter((r) => r.source === 'scim')).toHaveLength(3);
  });

  it('parks the project when the budget runs out and resumeReconcile finishes it', async () => {
    const s = await seedGroupGrant(t.db, 'SC2', 12);
    // 12 reads + a handful of writes: stops part way through the members.
    expect(await reconcileProjects(t.db, [s.projectId], new QueryBudget(20))).toBe(false);
    expect(await pendingReconcileProjects(t.db)).toEqual([s.projectId]);
    const partial = await t.db
      .select()
      .from(projectMember)
      .where(eq(projectMember.projectId, s.projectId));
    expect(partial.filter((r) => r.source === 'scim').length).toBeLessThan(12);

    // Each tick has a full budget, so one resumes everything; running it twice is harmless.
    expect(await resumeReconcile(t.db)).toEqual({ remaining: 0 });
    expect(await resumeReconcile(t.db)).toEqual({ remaining: 0 });
    const done = await t.db
      .select()
      .from(projectMember)
      .where(eq(projectMember.projectId, s.projectId));
    expect(done.filter((r) => r.source === 'scim')).toHaveLength(12);
  });
});

describe('createScimGroup', () => {
  it('lets exactly one of N simultaneous creates for one name through', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        createScimGroup(t.db, null, { displayName: 'same-name', externalId: null, members: [] }),
      ),
    );
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of refused) expect(r.reason).toMatchObject({ status: 409 });
  });
});
