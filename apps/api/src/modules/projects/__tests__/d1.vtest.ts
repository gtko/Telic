import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  issue,
  issueType,
  label,
  labelGroup,
  project,
  projectColumn,
  projectDocument,
  projectMember,
  projectSetting,
  projectView,
  team,
} from '@repo/db';
import { createTestDb, projectRowOf, seedProject, type TestDb } from '#tests/helpers/d1';
import { createIssue } from '#modules/issues/service';
import { copyProject } from '#modules/projects/copy';
import { createProject, deleteProject } from '#modules/projects/service';

// The D1 ports of the projects module, run against a local D1 with the real baseline.
let t: TestDb;
let n = 0;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.dispose());

async function seed() {
  n += 1;
  return seedProject(t.db, { key: `S${n}`, userId: `owner${n}` });
}

describe('createProject', () => {
  it('creates the project, its owner, columns, types and settings in one batch', async () => {
    const s = await seed();
    const created = await createProject(t.db, { key: 'NEWP', name: 'New' }, s.userId, s.teamId);
    const members = await t.db
      .select()
      .from(projectMember)
      .where(eq(projectMember.projectId, created.id));
    expect(members.map((m) => [m.userId, m.role])).toEqual([[s.userId, 'owner']]);
    const columns = await t.db
      .select()
      .from(projectColumn)
      .where(eq(projectColumn.projectId, created.id));
    expect(columns.length).toBeGreaterThanOrEqual(3);
    expect(columns.some((c) => c.stateType === 'backlog')).toBe(true);
    const types = await t.db.select().from(issueType).where(eq(issueType.projectId, created.id));
    expect(types.filter((x) => x.isDefault)).toHaveLength(1);
    const settings = await t.db
      .select()
      .from(projectSetting)
      .where(eq(projectSetting.projectId, created.id));
    expect(settings.map((x) => x.key)).toContain('auto_archive');
  });

  it('lets only one of two simultaneous creations with the same key through, leaving no orphan', async () => {
    const s = await seed();
    const results = await Promise.allSettled([
      createProject(t.db, { key: 'DUPE', name: 'A' }, s.userId, s.teamId),
      createProject(t.db, { key: 'DUPE', name: 'B' }, s.userId, s.teamId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await t.db
      .select()
      .from(project)
      .where(and(eq(project.teamId, s.teamId), eq(project.key, 'DUPE')));
    expect(rows).toHaveLength(1);
    const columns = await t.db
      .select()
      .from(projectColumn)
      .where(eq(projectColumn.projectId, rows[0].id));
    // The loser's batch rolled back whole: one project's worth of columns, not two.
    expect(columns).toHaveLength(
      (await t.db.select().from(projectColumn).where(eq(projectColumn.projectId, rows[0].id)))
        .length,
    );
    const owners = await t.db
      .select()
      .from(projectMember)
      .where(eq(projectMember.projectId, rows[0].id));
    expect(owners).toHaveLength(1);
  });
});

describe('deleteProject', () => {
  it('removes the project and everything that hangs from it', async () => {
    const s = await seed();
    const row = await createIssue(t.db, projectRowOf(s), {
      columnId: s.columnIds[0],
      title: 'gone',
    });
    await deleteProject(t.rt, s.projectId);
    expect(await t.db.select().from(project).where(eq(project.id, s.projectId))).toHaveLength(0);
    expect(await t.db.select().from(issue).where(eq(issue.id, row.id))).toHaveLength(0);
    expect(
      await t.db.select().from(projectColumn).where(eq(projectColumn.projectId, s.projectId)),
    ).toHaveLength(0);
  });
});

describe('copyProject', () => {
  async function source() {
    const s = await seed();
    const [{ id: typeId }] = await t.db
      .insert(issueType)
      .values({ projectId: s.projectId, name: 'Bug', isDefault: true, position: 0 })
      .returning({ id: issueType.id });
    const [{ id: groupId }] = await t.db
      .insert(labelGroup)
      .values({ projectId: s.projectId, name: 'Area', color: '#111111' })
      .returning({ id: labelGroup.id });
    const [{ id: labelId }] = await t.db
      .insert(label)
      .values({ projectId: s.projectId, groupId, name: 'ui', color: '#222222' })
      .returning({ id: label.id });
    await t.db.insert(projectView).values({
      projectId: s.projectId,
      name: 'Todo only',
      filters: { conditions: [{ field: 'status', op: 'is', values: [s.columnIds[1]] }] },
      display: {},
      position: 0,
    });
    return { s, typeId, groupId, labelId };
  }

  it('copies states, types, labels and views, remapping the ids views hold', async () => {
    const { s } = await source();
    const copy = await copyProject(
      t.db,
      t.bucket,
      s.projectId,
      { key: 'COPY', name: 'Copy' },
      s.userId,
      s.teamId,
    );
    expect(copy.id).not.toBe(s.projectId);
    const columns = await t.db
      .select()
      .from(projectColumn)
      .where(eq(projectColumn.projectId, copy.id))
      .orderBy(projectColumn.position);
    expect(columns.map((c) => c.name)).toEqual(['Backlog', 'Todo', 'Done']);
    expect(columns.some((c) => s.columnIds.includes(c.id))).toBe(false);
    expect(
      await t.db.select().from(issueType).where(eq(issueType.projectId, copy.id)),
    ).toHaveLength(1);
    const [copiedLabel] = await t.db.select().from(label).where(eq(label.projectId, copy.id));
    const [copiedGroup] = await t.db
      .select()
      .from(labelGroup)
      .where(eq(labelGroup.projectId, copy.id));
    expect(copiedLabel.groupId).toBe(copiedGroup.id);
    const [view] = await t.db.select().from(projectView).where(eq(projectView.projectId, copy.id));
    expect(view.filters).toMatchObject({ conditions: [{ values: [columns[1].id] }] });
    // No issue is copied, and the creator owns the copy.
    expect(await t.db.select().from(issue).where(eq(issue.projectId, copy.id))).toHaveLength(0);
    const [owner] = await t.db
      .select()
      .from(projectMember)
      .where(eq(projectMember.projectId, copy.id));
    expect([owner.userId, owner.role]).toEqual([s.userId, 'owner']);
  });

  it('deletes the half-built project when the copy fails part-way', async () => {
    const { s } = await source();
    await t.db.insert(projectDocument).values({
      projectId: s.projectId,
      title: 'Broken',
      contentJson: { type: 'not-a-doc' },
      ownerUserId: s.userId,
      createdByUserId: s.userId,
      updatedByUserId: s.userId,
    });
    await expect(
      copyProject(t.db, t.bucket, s.projectId, { key: 'HALF', name: 'Half' }, s.userId, s.teamId, {
        documents: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      await t.db
        .select()
        .from(project)
        .where(and(eq(project.teamId, s.teamId), eq(project.key, 'HALF'))),
    ).toHaveLength(0);
    // The team and the source are untouched.
    expect(await t.db.select().from(team).where(eq(team.id, s.teamId))).toHaveLength(1);
    expect(
      await t.db.select().from(projectColumn).where(eq(projectColumn.projectId, s.projectId)),
    ).toHaveLength(3);
  });

  it('refuses a source too large to copy within the D1 query budget, leaving nothing behind', async () => {
    const { s } = await source();
    const rows = Array.from({ length: 20 }, (_, i) => ({
      projectId: s.projectId,
      name: `L${i}`,
      color: '#333333',
    }));
    for (let batch = 0; batch < 50; batch++)
      await t.db
        .insert(label)
        .values(rows.map((r, i) => ({ ...r, name: `${r.name}-${batch}-${i}` })));
    await expect(
      copyProject(t.db, t.bucket, s.projectId, { key: 'BIG', name: 'Big' }, s.userId, s.teamId),
    ).rejects.toMatchObject({ status: 413 });
    expect(
      await t.db
        .select()
        .from(project)
        .where(and(eq(project.teamId, s.teamId), eq(project.key, 'BIG'))),
    ).toHaveLength(0);
  });
});
