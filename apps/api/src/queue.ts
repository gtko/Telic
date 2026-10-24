import type { Env } from './env';

// The body of a message on the run queue: an identifier and nothing else (a message is
// capped at 128 KB, and the agent_run row stays the source of truth).
export interface RunMessage {
  runId: number;
}

// The queue consumer: `worker.ts` hands every batch of RUN_QUEUE here.
//
// TODO(ody-296 l4): this is the seam, implemented by lot l4. Its body is to build the agent
// runtime from `env` and hand each message to consumeRunBatch (modules/agents/core/run-poller).
// Until then the batch is retried, not acknowledged: a message must never be dropped without
// its run having been looked at, and the cron catch-up (cron.ts) still finds the run.
export async function handleRunMessage(batch: MessageBatch<RunMessage>, _env: Env): Promise<void> {
  console.warn(
    `[queue] handleRunMessage is not implemented yet: retrying ${batch.messages.length}`,
  );
  batch.retryAll({ delaySeconds: 60 });
}
