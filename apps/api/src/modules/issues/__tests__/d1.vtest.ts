import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  issue,
  issueActivity,
  issueChecklist,
  issueChecklistItem,
  issueLink,
  project,
  projectColumn,
  projectSetting,
} from '@repo/db';
import { createTestDb, projectRowOf, seedProject, type TestDb } from '#tests/helpers/d1';
import { createIssue } from '#modules/issues/service';
import { moveIssue } from '#modules/issues/move';
import { addIssueLink, listIssueLinks, removeIssueLink } from '#modules/issues/links';
import {
  createChecklist,
  createChecklistItems,
  deleteChecklist,
  listChecklists,
} from '#modules/issues/checklists';
import { sweepStaleIssues } from '#modules/issues/auto-archive';
import { deleteColumn } from '#modules/columns/service';

// The D1 ports of the issues module, run against a local D1 with the real baseline.
let t: TestDb;
let n = 0;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.dispose());

// Each test seeds a project of its own, so tests do not see one another's rows.
async function seed(opts: Parameters<typeof seedProject>[1] = {}) {
  n += 1;
  return seedProject(t.db, { key: `P${n}`, userId: `u${n}`, ...opts });
}

describe('createIssue numbering', () => {
  it('gives parallel creations distinct, consecutive numbers', async () => {
    const s = await seed();
    const p = projectRowOf(s);
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        createIssue(t.db, p, { columnId: s.columnIds[0], title: `Task ${i}` }, s.userId),
      ),
    );
    const numbers = created.map((row) => row.sequenceNumber).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const [row] = await t.db.select().from(project).where(eq(project.id, s.projectId));
    expect(row.nextSequence).toBe(13);
    expect(new Set(created.map((r) => r.position)).size).toBe(12);
  });

  it('numbers each project on its own', async () => {
    const a = await seed();
    const b = await seed();
    const first = await createIssue(t.db, projectRowOf(a), {
      columnId: a.columnIds[0],
      title: 'x',
    });
    const other = await createIssue(t.db, projectRowOf(b), {
      columnId: b.columnIds[0],
      title: 'y',
    });
    expect([first.sequenceNumber, other.sequenceNumber]).toEqual([1, 1]);
  });
});

describe('deleteColumn keeps one backlog column', () => {
  it('lets only one of two simultaneous deletions of the last two backlog columns through', async () => {
    const s = await seed({
      columns: [
        { name: 'B1', stateType: 'backlog' },
        { name: 'B2', stateType: 'backlog' },
        { name: 'Done', stateType: 'completed' },
      ],
    });
    const [b1, b2] = s.columnIds;
    const results = await Promise.allSettled([
      deleteColumn(t.db, b1, s.projectId, { mode: 'delete' }, s.userId),
      deleteColumn(t.db, b2, s.projectId, { mode: 'delete' }, s.userId),
    ]);
    const columns = await t.db
      .select({ id: projectColumn.id, type: projectColumn.stateType })
      .from(projectColumn)
      .where(eq(projectColumn.projectId, s.projectId));
    expect(columns.filter((c) => c.type === 'backlog')).toHaveLength(1);
    expect(columns).toHaveLength(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('moves the issues of a deleted column to the target in one pass', async () => {
    const s = await seed();
    const [backlog, todo] = s.columnIds;
    const row = await createIssue(t.db, projectRowOf(s), { columnId: todo, title: 'moves' });
    await deleteColumn(
      t.db,
      todo,
      s.projectId,
      { mode: 'move', targetColumnId: backlog },
      s.userId,
    );
    const [after] = await t.db.select().from(issue).where(eq(issue.id, row.id));
    expect(after.columnId).toBe(backlog);
  });
});

describe('moveIssue', () => {
  it('moves an issue with its subtask to another project of the team, once, under concurrency', async () => {
    const src = await seed();
    const dst = await seedProject(t.db, { key: `D${n}`, teamId: src.teamId, userId: src.userId });
    const parent = await createIssue(t.db, projectRowOf(src), {
      columnId: src.columnIds[0],
      title: 'parent',
    });
    const child = await createIssue(t.db, projectRowOf(src), {
      columnId: src.columnIds[0],
      title: 'child',
      parentId: parent.id,
    });
    const settled = await Promise.allSettled([
      moveIssue(t.db, parent.id, projectRowOf(dst), undefined, src.userId),
      moveIssue(t.db, parent.id, projectRowOf(dst), undefined, src.userId),
    ]);
    const rows = await t.db
      .select({ id: issue.id, seq: issue.sequenceNumber })
      .from(issue)
      .where(eq(issue.projectId, dst.projectId));
    expect(rows.map((r) => r.id).sort()).toEqual([parent.id, child.id].sort());
    expect(new Set(rows.map((r) => r.seq)).size).toBe(2);
    expect(settled.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    const [dstProject] = await t.db.select().from(project).where(eq(project.id, dst.projectId));
    expect(dstProject.nextSequence).toBe(3);
  });
});

describe('links', () => {
  it('stores a relation once and rejects its inverse and duplicate', async () => {
    const s = await seed();
    const a = await createIssue(t.db, projectRowOf(s), { columnId: s.columnIds[0], title: 'a' });
    const b = await createIssue(t.db, projectRowOf(s), { columnId: s.columnIds[0], title: 'b' });
    await addIssueLink(t.db, a.id, b.id, 'blocks', s.userId);
    await expect(addIssueLink(t.db, a.id, b.id, 'blocks', s.userId)).rejects.toMatchObject({
      status: 409,
    });
    await expect(addIssueLink(t.db, b.id, a.id, 'blocks', s.userId)).rejects.toMatchObject({
      status: 409,
    });
    expect(await listIssueLinks(t.db, a.id)).toHaveLength(1);
  });

  it('lets exactly one of simultaneous identical links through, and removes it', async () => {
    const s = await seed();
    const a = await createIssue(t.db, projectRowOf(s), { columnId: s.columnIds[0], title: 'a' });
    const b = await createIssue(t.db, projectRowOf(s), { columnId: s.columnIds[0], title: 'b' });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => addIssueLink(t.db, a.id, b.id, 'relates', s.userId)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [link] = await listIssueLinks(t.db, a.id);
    const removals = await Promise.all([
      removeIssueLink(t.db, a.id, link.id, s.userId),
      removeIssueLink(t.db, a.id, link.id, s.userId),
    ]);
    expect(removals.filter(Boolean)).toHaveLength(1);
    expect(await listIssueLinks(t.db, a.id)).toHaveLength(0);
    expect(await t.db.select().from(issueLink).where(eq(issueLink.id, link.id))).toHaveLength(0);
  });
});

describe('checklists', () => {
  it('creates checklists and items with distinct positions under concurrency', async () => {
    const s = await seed();
    const i = await createIssue(t.db, projectRowOf(s), { columnId: s.columnIds[0], title: 'c' });
    const lists = await Promise.all(
      Array.from({ length: 5 }, (_, k) => createChecklist(t.db, i.id, `L${k}`, s.userId)),
    );
    expect(new Set(lists.map((l) => l.position)).size).toBe(5);
    const [first] = lists;
    const items = await createChecklistItems(
      t.db,
      first.id,
      [{ content: 'one' }, { content: 'two' }, { content: 'three' }],
      s.userId,
    );
    expect(items.map((x) => x.content)).toEqual(['one', 'two', 'three']);
    expect(new Set(items.map((x) => x.position)).size).toBe(3);
    expect(await listChecklists(t.db, i.id)).toHaveLength(5);
    await deleteChecklist(t.db, first.id, s.userId);
    expect(
      await t.db
        .select()
        .from(issueChecklistItem)
        .where(eq(issueChecklistItem.checklistId, first.id)),
    ).toHaveLength(0);
    expect(
      await t.db.select().from(issueChecklist).where(eq(issueChecklist.issueId, i.id)),
    ).toHaveLength(4);
  });
});

describe('auto-archive', () => {
  it('archives only stale issues of a done column past the threshold, and logs it', async () => {
    const s = await seed();
    const [backlog, , done] = s.columnIds;
    await t.db.insert(projectSetting).values({
      projectId: s.projectId,
      key: 'auto_archive',
      value: { completedDays: 7, canceledDays: null },
    });
    const old = await createIssue(t.db, projectRowOf(s), { columnId: done, title: 'old' });
    const fresh = await createIssue(t.db, projectRowOf(s), { columnId: done, title: 'fresh' });
    const open = await createIssue(t.db, projectRowOf(s), { columnId: backlog, title: 'open' });
    const longAgo = new Date(Date.now() - 30 * 86_400_000);
    for (const id of [old.id, open.id])
      await t.db.update(issue).set({ updatedAt: longAgo }).where(eq(issue.id, id));
    expect(await sweepStaleIssues(t.db)).toBe(1);
    expect(await sweepStaleIssues(t.db)).toBe(0);
    const rows = await t.db.select().from(issue).where(eq(issue.projectId, s.projectId));
    const archivedAt = new Map(rows.map((r) => [r.id, r.archivedAt]));
    expect(archivedAt.get(old.id)).toBeInstanceOf(Date);
    expect(archivedAt.get(fresh.id)).toBeNull();
    expect(archivedAt.get(open.id)).toBeNull();
    const activity = await t.db
      .select({ action: issueActivity.action })
      .from(issueActivity)
      .where(eq(issueActivity.issueId, old.id));
    expect(activity.map((a) => a.action)).toContain('archived');
  });
});
