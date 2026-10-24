import { dispatchInvocations, processAgentRuns, pruneAgentTraces, sweepStaleIssues } from './cron';
import type { Env } from './env';

// The cron expressions of wrangler.jsonc "triggers.crons". `scheduled` tells the two apart by
// the expression that fired, so the two lists must change together.
export const CRON_EVERY_MINUTE = '* * * * *';
export const CRON_HOURLY = '0 * * * *';

// What each trigger runs. The minutely one is the catch-up for the queue and for the external
// agents; the hourly one is housekeeping. The jobs are independent: they run side by side and
// one failing does not stop the others.
const JOBS: Record<string, readonly [name: string, job: (env: Env) => Promise<unknown>][]> = {
  [CRON_EVERY_MINUTE]: [
    ['agent-runs', processAgentRuns],
    ['agent-invocations', dispatchInvocations],
  ],
  [CRON_HOURLY]: [
    ['auto-archive', sweepStaleIssues],
    ['agent-traces', pruneAgentTraces],
  ],
};

// Runs the jobs of one trigger. Throws once every job has finished if any failed, so the
// invocation shows as failed in the dashboard without a failure hiding the others.
export async function runScheduled(cron: string, env: Env): Promise<void> {
  const jobs = JOBS[cron];
  if (!jobs) {
    console.warn(`[cron] no job for the trigger "${cron}"`);
    return;
  }
  const results = await Promise.allSettled(jobs.map(([, job]) => job(env)));
  const failures: unknown[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    console.error(`[cron] ${jobs[index]![0]} failed:`, result.reason);
    failures.push(result.reason);
  });
  if (failures.length > 0)
    throw new AggregateError(failures, `[cron] ${failures.length} job(s) failed`);
}
