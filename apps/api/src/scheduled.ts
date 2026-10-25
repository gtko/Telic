import { everyHour } from './cron';
import type { Env } from './env';

// The cron expression of wrangler.jsonc "triggers.crons"; the two must change together.
export const CRON_HOURLY = '0 * * * *';

const JOBS: Record<string, (env: Env) => Promise<void>> = {
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
