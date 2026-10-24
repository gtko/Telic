import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSetting } from '@repo/db';
import { processTelemetry } from '../../telemetry';
import { useTestEnv } from '../helpers/d1';

// readSnapshot / readLists / readAuthPolicy / installedDay are hand-written SQLite: this runs
// them against the real schema and checks the pulse that would leave the instance.

const ctx = useTestEnv();

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TELEMETRY_DISABLED;
});

describe('processTelemetry', () => {
  it('reads the instance snapshot with real SQL and posts one pulse a day', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body));
        return new Response('ok');
      }),
    );
    // 23:59 UTC: past whatever minute of the day the instance picked to send at.
    const now = Date.UTC(2030, 0, 15, 23, 59);

    await processTelemetry(ctx.db, now);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ day: '2030-01-15' });
    expect(JSON.stringify(sent[0])).toContain('cloudflare/workers');
    expect(await getSetting(ctx.db, 'telemetry.last_sent_day')).toBe('2030-01-15');

    await processTelemetry(ctx.db, now + 60_000);
    expect(sent).toHaveLength(1);
  });

  it('sends nothing when the operator opted out', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    process.env.TELEMETRY_DISABLED = '1';
    await processTelemetry(ctx.db, Date.UTC(2030, 0, 16, 23, 59));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
