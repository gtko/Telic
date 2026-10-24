import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, projectRowOf, seedProject, type TestDb } from '#tests/helpers/d1';
import { createIssue } from '#modules/issues/service';
import {
  getAgentRunStats,
  getBreakdown,
  getBurnup,
  getPulse,
  getStats,
  getThroughput,
  listActivity,
  pulseRows,
} from '../service';

// The SQLite ports of the analytics queries, against a local D1 with the real baseline.
let t: TestDb;
let n = 0;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.dispose());

async function seed() {
  n += 1;
  const s = await seedProject(t.db, { key: `AN${n}`, userId: `an-owner${n}` });
  return { s, row: projectRowOf(s) };
}

describe('analytics on D1', () => {
  it('counts open, overdue and unassigned issues and the breakdown by status', async () => {
    const { s, row } = await seed();
    await createIssue(t.db, row, {
      columnId: s.columnIds[0],
      title: 'late',
      dueDate: '2000-01-01',
    });
    await createIssue(t.db, row, { columnId: s.columnIds[0], title: 'fine' });
    const stats = await getStats(t.db, s.projectId);
    expect(stats.open).toBe(2);
    expect(stats.overdue).toBe(1);
    expect(stats.unassigned).toBe(2);
    expect(stats.closedLast7d).toBe(0);
    const byStatus = await getBreakdown(t.db, s.projectId, 'status');
    expect(byStatus.reduce((sum, i) => sum + i.count, 0)).toBe(2);
    expect(byStatus[0]!.key).toBe(String(s.columnIds[0]));
    const byPriority = await getBreakdown(t.db, s.projectId, 'priority');
    expect(byPriority.reduce((sum, i) => sum + i.count, 0)).toBe(2);
  });

  it('fills the pulse axis with zeros and counts the new activity in the last bucket', async () => {
    const { s, row } = await seed();
    await createIssue(t.db, row, { columnId: s.columnIds[0], title: 'a' });
    for (const unit of ['hour', 'day', 'week'] as const) {
      const buckets = await getPulse(t.db, s.projectId, unit, 3);
      expect(buckets).toHaveLength(3 * pulseRows(unit));
      expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBeGreaterThanOrEqual(1);
    }
    const mine = await getPulse(t.db, s.projectId, 'day', 2, 'nobody');
    expect(mine.reduce((sum, b) => sum + b.count, 0)).toBe(0);
  });

  it('counts created issues in the current week and builds the burnup series', async () => {
    const { s, row } = await seed();
    await createIssue(t.db, row, { columnId: s.columnIds[0], title: 'a' });
    const weeks = await getThroughput(t.db, s.projectId, 4);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]!.created).toBe(1);
    expect(weeks[0]!.week).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(weeks[0]!.week).getUTCDay()).toBe(1);

    const burnup = await getBurnup(t.db, s.projectId, {
      days: 7,
      initiativeId: null,
      forecastWeeks: 4,
    });
    expect(burnup.days).toHaveLength(7);
    expect(burnup.days[6]!.date).toBe(new Date().toISOString().slice(0, 10));
    expect(burnup.days[6]!.scope).toBe(1);
  });

  it('pages the activity feed with the keyset cursor', async () => {
    const { s, row } = await seed();
    for (const title of ['a', 'b', 'c']) {
      await createIssue(t.db, row, { columnId: s.columnIds[0], title });
    }
    const first = await listActivity(t.db, s.projectId, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listActivity(t.db, s.projectId, {
      limit: 2,
      before: first.nextCursor,
    });
    const ids = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(3);
  });

  it('returns zero agent run stats for a project without runs', async () => {
    const { s } = await seed();
    expect(await getAgentRunStats(t.db, s.projectId, 7)).toEqual({
      total: 0,
      success: 0,
      failed: 0,
      pending: 0,
    });
  });
});
