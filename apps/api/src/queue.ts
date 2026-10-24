import type { Env } from './env';
import { consumeRunMessages, runtimeOf } from './modules/agents/jobs';

// The body of a message on the run queue: an identifier and nothing else (a message is
// capped at 128 KB, and the agent_run row stays the source of truth).
export interface RunMessage {
  runId: number;
}

// The queue consumer: `worker.ts` hands every batch of RUN_QUEUE here. Each message is
// acknowledged or retried individually by consumeRunBatch; a run it names is claimed only
// if it is still due, so a duplicate delivery is harmless.
export async function handleRunMessage(batch: MessageBatch<RunMessage>, env: Env): Promise<void> {
  await consumeRunMessages(runtimeOf(env), batch.messages);
}
