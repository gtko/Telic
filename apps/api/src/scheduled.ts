import { everyHour, everyMinute } from './cron';
import type { Env } from './env';

// The cron expressions of wrangler.jsonc "triggers.crons". `scheduled` tells the two apart by
// the expression that fired, so the two lists must change together.
export const CRON_EVERY_MINUTE = '* * * * *';
export const CRON_HOURLY = '0 * * * *';

// What each trigger runs: the minutely one is the catch-up for the queue and for the external
// agents; the hourly one is housekeeping.
const JOBS: Record<string, (env: Env) => Promise<void>> = {
  [CRON_EVERY_MINUTE]: everyMinute,
  [CRON_HOURLY]: everyHour,
};

// Runs the jobs of one trigger. They throw once every job has finished if any failed, so the
// invocation shows as failed in the dashboard without a failure hiding the others.
export async function runScheduled(cron: string, env: Env): Promise<void> {
  const job = JOBS[cron];
  if (!job) {
    console.warn(`[cron] no job for the trigger "${cron}"`);
    return;
  }
  await job(env);
}
