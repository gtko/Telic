import { teamWorkspaceId } from '@repo/db';
import { getProjectTeamId } from '#modules/projects/service';
import { getAgentSettings } from '#modules/settings/service';
import { getLimits } from '#shared/limits';
import { framePrompt, peopleContext, runModePreamble } from './prompt/framing';
import { agentRunStarted, recordAgentRunFinished } from './run-activity';
import { runAdmissionDelay } from './run-admission';
import { runRefusal } from './run-refusal';
import {
  MAX_CONSUMER_RUN_SECONDS,
  agentRunConfig,
  claimRun,
  countRunsAhead,
  deferRun,
  explainMiss,
  markRunFailed,
  markRunExecuting,
  markRunSuccess,
  requeueRun,
  runRetryDelayMs,
  scheduleRunRetry,
  type ClaimedRun,
} from './run-queue';
import type { AgentRuntime, RunMessage } from './runtime/bindings';
import { STEP_LIMIT_MESSAGE, runAgent } from './runtime/entry';
import { runThreadId } from './runtime/thread-ids';

// Runs the agent_run rows a Cloudflare Queue consumer is told about. The message holds a
// run id and nothing else: the row is claimed here (one conditional UPDATE, see claimRun)
// and is the only thing a run is built from, so nothing about which project or which bot
// user it acts as can be handed in from outside.

// How long a run waits when its workspace has no free slot.
const DEFERRED_RETRY_SECONDS = 30;

// One queue message as the consumer sees it: the Workers `Message` reduced to what is used.
export interface RunQueueMessage {
  body: RunMessage;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

// The consumer's `queue(batch, env)` handler body. Messages run side by side; each is
// acknowledged once handled, and one that failed unexpectedly (a database outage, say) is
// retried later — the run it names is claimed only if it is still due.
export async function consumeRunBatch(
  rt: AgentRuntime,
  messages: readonly RunQueueMessage[],
): Promise<void> {
  await Promise.all(
    messages.map(async (message) => {
      try {
        await handleRunMessage(rt, message.body.runId);
        message.ack();
      } catch (error) {
        console.error(`[run-queue] run ${message.body.runId} failed:`, error);
        message.retry({ delaySeconds: 30 });
      }
    }),
  );
}

// Claims the run and executes it. A run that cannot be claimed is looked at again when
// it matters: after its retry delay, at the end of the lease another consumer holds, or
// shortly if an earlier run of its issue goes first. Duplicate messages find the run
// taken (or finished) and end here.
export async function handleRunMessage(
  rt: AgentRuntime,
  runId: number,
  now = Date.now(),
): Promise<'ran' | 'skipped'> {
  const run = await claimRun(rt.db, runId, now);
  if (!run) {
    const miss = await explainMiss(rt.db, runId, now);
    if (miss.retryInSeconds != null) await requeueRun(rt.queue, runId, miss.retryInSeconds);
    return 'skipped';
  }
  await processRun(rt, run);
  return 'ran';
}

async function processRun(rt: AgentRuntime, run: ClaimedRun): Promise<void> {
  const { db } = rt;
  const teamId = await getProjectTeamId(db, run.projectId);
  const workspaceId = await teamWorkspaceId(teamId, db);
  const { maxConcurrentRuns, maxRunSeconds } = await getLimits(db, workspaceId);
  if (
    maxConcurrentRuns > 0 &&
    (await countRunsAhead(db, workspaceId, run.id)) >= maxConcurrentRuns
  ) {
    await deferRun(db, run.id, DEFERRED_RETRY_SECONDS);
    await requeueRun(rt.queue, run.id, DEFERRED_RETRY_SECONDS);
    return;
  }
  const wait = await runAdmissionDelay(run);
  if (wait > 0) {
    await deferRun(db, run.id, wait);
    await requeueRun(rt.queue, run.id, wait);
    return;
  }
  // Refused before anything is recorded on the issue, and not retried: the attempt would
  // be refused for the same reason.
  const refused = await runRefusal({
    agentId: run.agentId,
    teamId,
    projectId: run.projectId,
    userId: run.requesterUserId,
  });
  if (refused) {
    await markRunFailed(db, run.id, refused);
    return;
  }
  // The issue's timeline entries are written here, where the agent's work actually
  // starts and ends. A failure that will be retried is not the end of the run, so only
  // the last attempt logs one.
  const configuredTimeoutMs = runTimeoutMs(
    run.agentRunTimeoutSec,
    (await getAgentSettings(db)).maxRunSeconds,
    maxRunSeconds,
  );
  if (run.executionDeadline <= Date.now()) return;
  try {
    await agentRunStarted(db, run);
    if (!(await markRunExecuting(db, run.id, run.attempts))) return;
    const timeoutMs = Math.floor(Math.min(configuredTimeoutMs, run.executionDeadline - Date.now()));
    if (timeoutMs <= 0) {
      await recordAgentRunFinished(db, run, 'failed');
      await markRunFailed(db, run.id, 'Claim execution budget exhausted');
      return;
    }
    const result = await runAgent(rt, run.agentId, run.projectId, framePrompt(run), {
      callerUserId: run.agentUserId,
      threadId: runThreadId(run),
      issueId: run.issueId,
      scheduleId: run.scheduleId,
      runId: run.id,
      trigger: run.trigger,
      contextPreamble: runModePreamble(run.trigger) + peopleContext(run),
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    if (result.aborted) {
      // Mastra resolves generate() on abort, so the partial text would read as a success.
      // Not retried: a run that hits the time limit will hit it again.
      await recordAgentRunFinished(db, run, 'failed');
      await markRunFailed(
        db,
        run.id,
        `Timed out after ${Math.round(timeoutMs / 1000)}s`,
        result.text,
      );
      return;
    }
    if (result.stepLimit) {
      await recordAgentRunFinished(db, run, 'failed');
      await markRunFailed(db, run.id, STEP_LIMIT_MESSAGE);
      return;
    }
    await recordAgentRunFinished(db, run, 'success');
    await markRunSuccess(db, run.id, result.text, result.usage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (run.attempts < agentRunConfig.maxAttempts()) {
      const delayMs = runRetryDelayMs(run.attempts);
      await scheduleRunRetry(db, run.id, delayMs, message);
      await requeueRun(rt.queue, run.id, delayMs / 1000);
      return;
    }
    await recordAgentRunFinished(db, run, 'failed');
    await markRunFailed(db, run.id, message);
  }
}

// The wall time a run gets: the agent's own limit or else the instance's maximum, never
// above that maximum or the workspace's ceiling where it has one. Without a limit a run
// that never returns holds its slot until the claim lease expires and is then started
// again, having recorded nothing.
function runTimeoutMs(
  agentSeconds: number | null,
  instanceSeconds: number,
  workspaceSeconds: number,
): number {
  // Never more than a queue consumer invocation can give (MAX_CONSUMER_RUN_SECONDS).
  const seconds = Math.min(
    agentSeconds ?? instanceSeconds,
    instanceSeconds,
    MAX_CONSUMER_RUN_SECONDS,
  );
  return (workspaceSeconds > 0 ? Math.min(seconds, workspaceSeconds) : seconds) * 1000;
}
