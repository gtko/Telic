import type { Env } from './env';
import { runHourlyJobs, runMinuteJobs, runtimeOf } from './modules/agents/jobs';

// The catch-up jobs the cron triggers run. They replace the setInterval loops of the old
// background.ts: a Worker has no process to keep a timer in, so each trigger calls these.
// Every job is idempotent and safe to overlap with the queue consumer (a run is claimed by one
// conditional UPDATE); the jobs live in modules/agents/jobs.ts.
export const everyMinute = (env: Env): Promise<void> => runMinuteJobs(runtimeOf(env));
export const everyHour = (env: Env): Promise<void> => runHourlyJobs(runtimeOf(env));
