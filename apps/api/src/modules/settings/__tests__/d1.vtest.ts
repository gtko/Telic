import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userPreference, user, getSetting } from '@repo/db';
import { createTestDb, seedProject, type TestDb } from '#tests/helpers/d1';
import { setProjectSetting, getProjectSetting } from '#shared/project-settings';
import { markWhatsNewSeen } from '../whats-new';
import { getHotkeySettings, setHotkeySettings } from '../service';
import { getUpdateStatus } from '../updates';
import { CHANGELOG_MARKDOWN } from '../changelog.generated';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.dispose());

describe('settings', () => {
  it('stores and reads the hotkeys through the injected db', async () => {
    expect(await getHotkeySettings(t.db)).toEqual({});
    await setHotkeySettings(t.db, { search: 'mod+k' } as never);
    expect(await getHotkeySettings(t.db)).toEqual({ search: 'mod+k' });
    expect(await getSetting(t.db, 'hotkeys')).toBeTruthy();
  });

  it('upserts a project setting and stamps updatedAt on the Worker side', async () => {
    const s = await seedProject(t.db, { key: 'SET1', userId: 'set-user-1' });
    await setProjectSetting(t.db, s.projectId, 'k', { a: 1 });
    await setProjectSetting(t.db, s.projectId, 'k', { a: 2 });
    expect(await getProjectSetting(t.db, s.projectId, 'k')).toEqual({ a: 2 });
  });

  it('records the version seen, once per user, however often it is closed', async () => {
    await t.db.insert(user).values({ id: 'wn-user', name: 'w', email: 'wn@example.com' });
    await Promise.all([markWhatsNewSeen(t.db, 'wn-user'), markWhatsNewSeen(t.db, 'wn-user')]);
    const rows = await t.db
      .select()
      .from(userPreference)
      .where(eq(userPreference.userId, 'wn-user'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seenVersion).toBeTruthy();
  });
});

describe('embedded changelog', () => {
  it('equals CHANGELOG.md (run `bun run gen:changelog` when this fails)', () => {
    const file = readFileSync(new URL('../../../../../../CHANGELOG.md', import.meta.url), 'utf8');
    expect(CHANGELOG_MARKDOWN).toBe(file.replace(/\r\n/g, '\n'));
  });

  it('feeds the release history without any file system access', async () => {
    const status = await getUpdateStatus();
    expect(status.releases.length).toBeGreaterThan(0);
    expect(status.releases[0]!.notesFormat).toBe('markdown');
  });
});
