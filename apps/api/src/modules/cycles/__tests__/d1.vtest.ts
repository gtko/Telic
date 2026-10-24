import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedProject, type TestDb } from '#tests/helpers/d1';
import {
  createCycle,
  finishCycle,
  listCompletedCycles,
  listPlannedCycles,
  startNextCycle,
} from '../service';

let t: TestDb;
let n = 0;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.dispose());

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function seed() {
  n += 1;
  return seedProject(t.db, { key: `C${n}`, userId: `cyc-owner${n}` });
}

describe('cycles on D1', () => {
  it('splits planned and finished cycles on today and the completion stamp', async () => {
    const s = await seed();
    const past = await createCycle(t.db, s.projectId, {
      name: 'Past',
      startDate: day(-20),
      endDate: day(-10),
    });
    const active = await createCycle(t.db, s.projectId, {
      name: 'Active',
      startDate: day(-2),
      endDate: day(5),
    });
    const planned = await listPlannedCycles(t.db, s.projectId);
    expect(planned.map((c) => c.id)).toEqual([active.id]);
    const archive = await listCompletedCycles(t.db, s.projectId, { limit: 10, offset: 0 });
    expect(archive.items.map((c) => c.id)).toEqual([past.id]);
    expect(archive.total).toBe(1);
  });

  it('finishing a cycle stamps completedAt and frees the days after the stamp day', async () => {
    const s = await seed();
    const running = await createCycle(t.db, s.projectId, {
      name: 'Running',
      startDate: day(-2),
      endDate: day(10),
    });
    const before = Date.now();
    const finished = await finishCycle(t.db, running.id);
    expect(finished!.status).toBe('completed');
    expect(Date.parse(finished!.completedAt!)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(finished!.completedAt!)).toBeLessThanOrEqual(Date.now() + 1000);
    await expect(
      createCycle(t.db, s.projectId, { name: 'Overlap', startDate: day(-1), endDate: day(3) }),
    ).rejects.toThrow('overlap');
    const next = await createCycle(t.db, s.projectId, {
      name: 'Today',
      startDate: day(0),
      endDate: day(3),
    });
    expect(next.status).toBe('active');
  });

  it('starting the next cycle finishes the running one and moves the next start to today', async () => {
    const s = await seed();
    const running = await createCycle(t.db, s.projectId, {
      name: 'Running',
      startDate: day(-2),
      endDate: day(3),
    });
    const upcoming = await createCycle(t.db, s.projectId, {
      name: 'Upcoming',
      startDate: day(10),
      endDate: day(20),
    });
    const started = await startNextCycle(t.db, running.id);
    expect(started!.id).toBe(upcoming.id);
    expect(started!.startDate).toBe(day(0));
    expect(started!.status).toBe('active');
  });
});
