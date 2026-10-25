import { createDb } from '@repo/db';
import type { Env } from './env';
import { sweepStaleIssues } from '#modules/issues/auto-archive';
import { resumeReconcile } from '#modules/scim/reconcile';

// The catch-up jobs the hourly cron trigger runs. A Worker has no process to keep a timer in, so
// the trigger calls them. Every job is idempotent.
export async function everyHour(env: Env): Promise<void> {
  const db = createDb(env.DB);
  const jobs: [name: string, job: () => Promise<unknown>][] = [
    ['auto-archive', () => sweepStaleIssues(db)],
    ['scim-reconcile', () => resumeReconcile(db)],
  ];
  const results = await Promise.allSettled(jobs.map(([, job]) => job()));
  const failures: unknown[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    console.error(`[cron] ${jobs[index]![0]} failed:`, result.reason);
    failures.push(result.reason);
  });
  if (failures.length > 0)
    throw new AggregateError(failures, `[cron] ${failures.length} job(s) failed`);
}
