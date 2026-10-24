import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userPreference } from '@repo/db';
import { createTestDb, seedProject, type TestDb } from '#tests/helpers/d1';
import { getPreferences, updatePreferences } from '../service';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.dispose());

describe('user preferences on D1', () => {
  it('upserts a row and stamps updated_at with a real timestamp on the conflict path', async () => {
    const s = await seedProject(t.db, { key: 'UP1', userId: 'pref-user' });
    await updatePreferences(t.db, s.userId, { theme: 'dark' });
    const before = Date.now();
    const next = await updatePreferences(t.db, s.userId, { timezone: 'Europe/Zurich' });
    expect(next.theme).toBe('dark');
    expect(await getPreferences(t.db, s.userId)).toMatchObject({
      theme: 'dark',
      timezone: 'Europe/Zurich',
    });
    const [row] = await t.db
      .select()
      .from(userPreference)
      .where(eq(userPreference.userId, s.userId));
    expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});
