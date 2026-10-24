import type { Env } from './env';

// The catch-up jobs the cron triggers run. They replace the setInterval loops of the old
// background.ts: a Worker has no process to keep a timer in, so each trigger calls these.
// Every job is idempotent and safe to overlap with the queue consumer (a run is claimed by one
// conditional UPDATE), and each takes the Worker's `env` and builds what it needs from it.
//
// TODO(ody-296 l4): the bodies are implemented by lot l4, which owns the four functions
// (modules/agents/core/run-poller, modules/agents/invocation/service, modules/issues/auto-archive,
// modules/agents/core/runtime/trace-retention). This file is the seam `worker.ts` imports, so the
// signatures are fixed here; a body that is still a no-op only logs.

function pending(name: string): void {
  console.warn(`[cron] ${name} is not implemented yet (lot l4)`);
}

// Runs the agent_run rows the queue did not deliver (a run queued while no queue was bound, a
// message lost, a lease that expired).
export async function processAgentRuns(_env: Env): Promise<void> {
  pending('processAgentRuns');
}

// Sends the work of external agents that have an invocation URL.
export async function dispatchInvocations(_env: Env): Promise<void> {
  pending('dispatchInvocations');
}

// Archives the issues that stayed done long enough. Returns how many were archived.
export async function sweepStaleIssues(_env: Env): Promise<number> {
  pending('sweepStaleIssues');
  return 0;
}

// Deletes the agent trace spans past the retention window. Returns how many were deleted.
export async function pruneAgentTraces(_env: Env): Promise<number> {
  pending('pruneAgentTraces');
  return 0;
}
