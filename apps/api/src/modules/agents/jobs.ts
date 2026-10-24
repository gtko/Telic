import { createAuth } from '@repo/auth';
import { createDb } from '@repo/db';
import type { Env } from '../../env';
import { sweepStaleIssues } from '#modules/issues/auto-archive';
import { resumeReconcile } from '#modules/scim/reconcile';
import { rescueDueRuns } from './core/run-queue';
import { consumeRunBatch, type RunQueueMessage } from './core/run-poller';
import { agentRuntime, type AgentRuntime } from './core/runtime/bindings';
import { pruneAgentTraces } from './core/runtime/trace-retention';
import { dispatchInvocations } from './invocation/service';

// The agent runtime of a Worker invocation (cron or queue): the Drizzle client, the raw D1
// binding, the bucket and the queue, with the better-auth instance an internal agent's key
// is issued through. A route gets the same from `ctx` through agentRuntime directly.
export function runtimeOf(env: Env): AgentRuntime {
  const db = createDb(env.DB);
  return agentRuntime(env, createAuth(env, db));
}

// Every minute: re-send the runs whose message was lost, then call the external agents.
// Each job is independent; a failure of one does not stop the other, and both are
// idempotent so they may overlap with the queue consumer.
export async function runMinuteJobs(rt: AgentRuntime): Promise<void> {
  await settle([
    ['agent-runs', () => rescueDueRuns(rt.db, rt.queue)],
    ['agent-invocations', () => dispatchInvocations(rt.db)],
  ]);
}

// Every hour: archive the issues done long enough, prune the old spans, and finish the
// SCIM reconciliations that ran out of query budget.
export async function runHourlyJobs(rt: AgentRuntime): Promise<void> {
  await settle([
    ['auto-archive', () => sweepStaleIssues(rt.db)],
    ['agent-traces', () => pruneAgentTraces(rt)],
    ['scim-reconcile', () => resumeReconcile(rt.db)],
  ]);
}

export function consumeRunMessages(
  rt: AgentRuntime,
  messages: readonly RunQueueMessage[],
): Promise<void> {
  return consumeRunBatch(rt, messages);
}

async function settle(jobs: [name: string, job: () => Promise<unknown>][]): Promise<void> {
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
