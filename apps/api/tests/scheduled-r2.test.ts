import { env } from 'cloudflare:workers';
import { aiSpans, createDb } from '@repo/db';
import { getObjectText, putObject, useR2Bucket } from '@repo/storage';
import { describe, expect, it } from 'vitest';
import { setAgentSettings } from '#modules/settings/service';
import worker from '../src/worker';

const HOURLY = '0 * * * *';

describe('scheduled handler and R2', () => {
  it('deletes the bucket object of an trace with no team and points @repo/storage at BUCKET', async () => {
    const db = createDb(env.DB);
    const DAY = 86_400_000;
    await setAgentSettings(db, { traceRetentionDays: 30 });
    await env.BUCKET.put('spans/old-trace/x.input.json', '{}');
    for (const traceId of ['old-trace']) {
      const startedAt = Date.now() - 40 * DAY;
      await db.insert(aiSpans).values([
        { traceId, spanId: `${traceId}-root`, name: 'agent run', spanType: 'agent_run', startedAt },
        {
          traceId,
          spanId: `${traceId}-tool`,
          parentSpanId: `${traceId}-root`,
          name: 'tool',
          spanType: 'tool_call',
          startedAt,
          inputRef: `spans/${traceId}/x.input.json`,
        },
      ]);
    }

    useR2Bucket(null);
    await worker.scheduled(
      { cron: HOURLY, scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
      env as never,
    );

    expect(await env.BUCKET.get('spans/old-trace/x.input.json')).toBeNull();

    await putObject('via-storage.txt', new TextEncoder().encode('hi'), 'text/plain');
    expect(await getObjectText('via-storage.txt')).toBe('hi');
    expect(await env.BUCKET.get('via-storage.txt')).not.toBeNull();
  });
});
