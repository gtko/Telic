import { agentRun, issue, project, team, type Db } from '@repo/db';
import { and, desc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { getAgentSettings } from '#modules/settings/service';
import { intEnv, iso } from '#shared/lib';
import type { AgentRunTrigger } from '../model';
import { equalJitterBackoffMs } from './helpers/backoff';
import type { RunMessage, RunQueueLike } from './runtime/bindings';

// The agent_run outbox: data access for triggered runs and run history.
//
// `agent_run` is the source of truth. A run is queued by INSERTing its row and then
// sending `{ runId }` on the Cloudflare Queue (a message carries an identifier, never the
// run: it is capped at 128 KB). A consumer claims the row with one conditional UPDATE, so
// the queue may deliver a message twice, late, or never: the claim decides, and the cron
// (`rescueDueRuns`) re-sends the runs that are due and whose message was lost.

// Tuning, env-overridable with defaults. A claim's lease must exceed a run's wall time
// so a row is not re-claimed while its run is still in flight: claimRun raises it
// above the run's maximum time when that is longer.
export const agentRunConfig = {
  batchSize: () => intEnv('AGENT_RUN_BATCH_SIZE', 5),
  maxAttempts: () => intEnv('AGENT_RUN_MAX_ATTEMPTS', 3),
  leaseSeconds: () => intEnv('AGENT_RUN_LEASE_SECONDS', 300),
};

// A Queue consumer invocation lives 15 minutes of wall time, so no run may be given more
// than this, whatever the instance, the workspace or the agent allows.
export const MAX_CONSUMER_RUN_SECONDS = 840;

// Time a claim's lease leaves after the run's time limit, for recording the outcome.
export const LEASE_MARGIN_SECONDS = 60;

// A due run is re-sent by the cron only once its message is this overdue, so a run whose
// message is on its way is not sent twice.
export const RESCUE_GRACE_MS = 15_000;

// How long a message waits before looking again at a run that is blocked by an earlier
// run of the same agent and issue.
const BLOCKED_RETRY_SECONDS = 15;
// The longest delay a Queue accepts is 12 hours.
const MAX_QUEUE_DELAY_SECONDS = 43_200;

const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 30 * 60_000;

// How long a run waits before its next attempt after the given one failed.
export function runRetryDelayMs(attempts: number): number {
  return equalJitterBackoffMs(attempts, RETRY_BASE_MS, RETRY_CAP_MS);
}

// SQL-side "now" in epoch milliseconds, for the columns that hold an expression of it.
export const nowSql = sql`CAST(unixepoch('subsecond') * 1000 AS INTEGER)`;

// The condition a candidate run `q` of a claim meets when it is its turn. The runs of
// one agent on one issue share the agent's conversation thread and act on the same
// issue, so they go one at a time, oldest first: a run waits while another of them
// holds a slot (claimed and inside its lease, or waiting out a retry), and while an
// older one is due, which the same claim takes instead. D1 runs one write at a time and
// this is part of the claiming statement, so two claims never both pass it.
export function issueRunTurn(now: number) {
  return sql`NOT EXISTS (
  SELECT 1 FROM agent_run o
  WHERE o.agent_id = q.agent_id AND o.issue_id = q.issue_id AND o.id <> q.id
    AND o.status = 'pending'
    AND ((o.started_at IS NOT NULL AND o.next_attempt_at > ${now})
      OR (o.next_attempt_at <= ${now} AND o.id < q.id))
)`;
}

// Runs of this workspace's agents that hold a slot and were queued before this one. A claim
// stamps started_at and pushes next_attempt_at forward, so a pending run that is
// stamped and still inside that window is one of them — as is a run waiting out its
// retry backoff, which holds a slot it is not using. Counting only the older runs is
// what keeps a ceiling from turning away every run of a burst at once: each yields to
// the ones ahead of it and the rest come back on their next attempt.
export async function countRunsAhead(
  db: Db,
  workspaceId: number,
  runId: number,
  now = Date.now(),
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(agentRun)
    .innerJoin(project, eq(project.id, agentRun.projectId))
    .innerJoin(team, eq(team.id, project.teamId))
    .where(
      and(
        eq(team.workspaceId, workspaceId),
        eq(agentRun.status, 'pending'),
        isNotNull(agentRun.startedAt),
        gt(agentRun.nextAttemptAt, new Date(now)),
        lt(agentRun.id, runId),
      ),
    );
  return row?.count ?? 0;
}

// Sends the message of a run. A failure is swallowed: the row is already stored, and the
// cron sends the message of any due run that has none.
export async function sendRunMessage(
  queue: RunQueueLike | null | undefined,
  runId: number,
  delaySeconds: number,
): Promise<void> {
  if (!queue) return;
  const delay = Math.min(Math.max(0, Math.ceil(delaySeconds)), MAX_QUEUE_DELAY_SECONDS);
  try {
    await queue.send({ runId } satisfies RunMessage, delay > 0 ? { delaySeconds: delay } : {});
  } catch (error) {
    console.error(`[run-queue] could not send run ${runId}:`, error);
  }
}

// Queues a run: the row first, then its message. Without a queue (a caller that has no
// binding in reach) the cron picks the run up within a minute.
export async function enqueueAgentRun(
  db: Db,
  input: {
    agentId: number;
    // The project the run works in, which is the issue's. An agent works in several
    // projects, so the run carries its own rather than reading the agent's.
    projectId: number;
    issueId: number;
    sourceActivityId: number | null;
    prompt: string;
    trigger?: 'mention' | 'delegation' | 'field';
    // Seconds the run stays unclaimable after it is queued, so the issue can still be
    // edited before the agent reads it.
    delaySeconds?: number;
  },
  queue?: RunQueueLike | null,
  now = Date.now(),
): Promise<number> {
  const delay = Math.max(0, Math.trunc(input.delaySeconds ?? 0));
  const [row] = await db
    .insert(agentRun)
    .values({
      agentId: input.agentId,
      projectId: input.projectId,
      issueId: input.issueId,
      sourceActivityId: input.sourceActivityId,
      prompt: input.prompt,
      trigger: input.trigger ?? (input.sourceActivityId == null ? 'delegation' : 'mention'),
      nextAttemptAt: new Date(now + delay * 1000),
    })
    .returning({ id: agentRun.id });
  await sendRunMessage(queue, row!.id, delay);
  return row!.id;
}

export interface ClaimedRun {
  id: number;
  agentId: number;
  // Null for a cron schedule's run or a manual one, which works on no single issue.
  issueId: number | null;
  scheduleId: number | null;
  trigger: AgentRunTrigger;
  prompt: string;
  attempts: number;
  // The source comment id when the run was triggered by a mention, null for a
  // delegation. The poller frames the task differently for each.
  sourceActivityId: number | null;
  // The run's project and the agent's bot user, read inline so the poller can run it
  // without a second query.
  projectId: number;
  agentUserId: string;
  // The agent's own run time limit, null when it uses the instance's maximum.
  agentRunTimeoutSec: number | null;
  // Wall-clock deadline (epoch ms) that leaves the claim's margin for recording the
  // outcome.
  executionDeadline: number;
  // The agent's own handle, so the prompt can tell whether the text addressed it.
  agentUsername: string;
  // The issue's human-readable key ("MKT-42") and title, read inline so the poller can
  // frame the run with them. Null if the issue was deleted after enqueue.
  issueIdentifier: string | null;
  issueTitle: string | null;
  // The issue's assignee (the responsible human) and, for a mention run, the author of
  // the comment that mentioned the agent (from the source activity's name snapshot) with
  // their account. Each carries the handle the agent tags them by. Any may be null: no
  // assignee, a deleted user, or a run with no source comment.
  assigneeName: string | null;
  assigneeUsername: string | null;
  requesterName: string | null;
  requesterUsername: string | null;
  requesterUserId: string | null;
  // The comments the source comment replies to, oldest first, when it is a reply.
  // Null for a top-level mention or a delegation.
  threadContext: string | null;
}

// The seconds a claim's lease lasts: the configured lease, or more when the run may take
// longer. The run's time is capped at what a consumer invocation can give.
export async function claimLeaseSeconds(db: Db): Promise<number> {
  const maxRun = Math.min((await getAgentSettings(db)).maxRunSeconds, MAX_CONSUMER_RUN_SECONDS);
  return Math.max(agentRunConfig.leaseSeconds(), maxRun + LEASE_MARGIN_SECONDS);
}

// The columns a claimed run is read with, joined inline so a run starts without a second
// query. `r` is the claimed row.
const claimedColumns = sql`
  r.id AS id,
  r.agent_id AS agentId,
  r.issue_id AS issueId,
  r.schedule_id AS scheduleId,
  r.trigger AS trigger,
  r.prompt AS prompt,
  r.attempts AS attempts,
  r.source_activity_id AS sourceActivityId,
  r.project_id AS projectId,
  (SELECT user_id FROM ai_agent a WHERE a.id = r.agent_id) AS agentUserId,
  (SELECT username FROM ai_agent a WHERE a.id = r.agent_id) AS agentUsername,
  (SELECT run_timeout_sec FROM ai_agent a WHERE a.id = r.agent_id) AS agentRunTimeoutSec,
  (SELECT p.key || '-' || i.sequence_number
     FROM issue i JOIN project p ON p.id = i.project_id
     WHERE i.id = r.issue_id) AS issueIdentifier,
  (SELECT title FROM issue i WHERE i.id = r.issue_id) AS issueTitle,
  (SELECT u.name FROM issue i JOIN "user" u ON u.id = i.assignee_user_id
     WHERE i.id = r.issue_id) AS assigneeName,
  (SELECT COALESCE(u.username, ag.username)
     FROM issue i JOIN "user" u ON u.id = i.assignee_user_id
     LEFT JOIN ai_agent ag ON ag.user_id = u.id
     WHERE i.id = r.issue_id) AS assigneeUsername,
  (SELECT actor_name FROM issue_activity a WHERE a.id = r.source_activity_id) AS requesterName,
  (SELECT COALESCE(u.username, ag.username)
     FROM issue_activity a JOIN "user" u ON u.id = a.actor_user_id
     LEFT JOIN ai_agent ag ON ag.user_id = u.id
     WHERE a.id = r.source_activity_id) AS requesterUsername,
  (SELECT actor_user_id FROM issue_activity a WHERE a.id = r.source_activity_id) AS requesterUserId`;

// Atomically claims one run of an internal agent, or returns null when it cannot be: it is
// finished or canceled, not yet due, leased by another consumer, or waiting its turn on
// its issue. One UPDATE decides, so however many consumers receive the same message at
// once, exactly one gets the row. Claiming bumps attempts and pushes next_attempt_at
// forward by the lease while keeping status 'pending', so a run whose consumer dies
// mid-flight becomes claimable again after the lease — no separate recovery pass. An
// external agent's runs are left alone: they are claimed over HTTP by the operator's
// runner (modules/agents/runner).
export async function claimRun(
  db: Db,
  runId: number,
  now = Date.now(),
): Promise<ClaimedRun | null> {
  const leaseSeconds = await claimLeaseSeconds(db);
  const claimed = await db.all<{ id: number }>(sql`
    UPDATE agent_run AS q
    SET attempts = q.attempts + 1,
        started_at = coalesce(q.started_at, ${now}),
        execution_started_at = NULL,
        next_attempt_at = ${now + leaseSeconds * 1000}
    WHERE q.id = ${runId} AND q.status = 'pending' AND q.next_attempt_at <= ${now}
      AND (SELECT kind FROM ai_agent a WHERE a.id = q.agent_id) = 'internal'
      AND ${issueRunTurn(now)}
    RETURNING q.id AS id
  `);
  if (claimed.length === 0) return null;
  const [run] = await db.all<Omit<ClaimedRun, 'executionDeadline' | 'threadContext'>>(sql`
    SELECT ${claimedColumns} FROM agent_run r WHERE r.id = ${runId}
  `);
  if (!run) return null;
  return {
    ...run,
    executionDeadline: now + (leaseSeconds - LEASE_MARGIN_SECONDS) * 1000,
    threadContext: await loadThreadContext(db, run.sourceActivityId),
  };
}

// What a message found when its run could not be claimed.
export type ClaimMiss =
  // Finished, canceled, deleted, an external agent's, or in flight under a live lease whose
  // end a delayed message is already watching: nothing more to do.
  | { retryInSeconds: null }
  // Still pending: look again in this many seconds (its retry delay, the end of a lease, or
  // the wait for its turn on the issue).
  | { retryInSeconds: number };

// Why a run could not be claimed, as the delay after which its message should look again.
// A run that is leased or waiting out a delay yields the time left, so the message that
// finds it busy also covers the expiry of a lease whose consumer died.
export async function explainMiss(db: Db, runId: number, now = Date.now()): Promise<ClaimMiss> {
  const [row] = await db
    .select({ status: agentRun.status, nextAttemptAt: agentRun.nextAttemptAt })
    .from(agentRun)
    .where(eq(agentRun.id, runId));
  if (!row || row.status !== 'pending') return { retryInSeconds: null };
  const left = row.nextAttemptAt.getTime() - now;
  if (left > 0) return { retryInSeconds: Math.ceil(left / 1000) + 1 };
  return { retryInSeconds: BLOCKED_RETRY_SECONDS };
}

// Sends the message that makes a consumer look at the run again after the delay.
export function requeueRun(
  queue: RunQueueLike | null | undefined,
  runId: number,
  delaySeconds: number,
): Promise<void> {
  return sendRunMessage(queue, runId, delaySeconds);
}

// The runs of internal agents that are due and whose message may have been lost: pending,
// due for more than the grace period (a run that was just queued has its message on its
// way) and not blocked by an earlier run of its issue, which watches its own turn. A run
// whose lease expired is among them, which is the recovery of a consumer that died.
export async function findDueRunIds(db: Db, now = Date.now(), limit = 100): Promise<number[]> {
  const rows = await db.all<{ id: number }>(sql`
    SELECT q.id AS id FROM agent_run q
    WHERE q.status = 'pending' AND q.next_attempt_at <= ${now - RESCUE_GRACE_MS}
      AND (SELECT kind FROM ai_agent a WHERE a.id = q.agent_id) = 'internal'
      AND ${issueRunTurn(now)}
    ORDER BY q.next_attempt_at, q.id
    LIMIT ${limit}
  `);
  return rows.map((row) => row.id);
}

// The cron's catch-up: re-sends the message of every due run. Safe to run as often as
// wanted and from several places at once — a message for a run that is already claimed
// finds it taken and drops. Returns how many runs were sent.
export async function rescueDueRuns(
  db: Db,
  queue: RunQueueLike | null | undefined,
  now = Date.now(),
): Promise<number> {
  if (!queue) return 0;
  const ids = await findDueRunIds(db, now);
  // sendBatch takes at most 100 messages.
  for (let i = 0; i < ids.length; i += 100) {
    await queue.sendBatch(ids.slice(i, i + 100).map((runId) => ({ body: { runId } })));
  }
  return ids.length;
}

// How far up a thread the agent is given. Further up, the exchange is too far from
// the question to pay for the tokens it costs.
const THREAD_CONTEXT_DEPTH = 5;

// The comments the given one replies to, oldest first and at most
// THREAD_CONTEXT_DEPTH of them, as the text a prompt carries. Null when the comment
// is not a reply.
export async function loadThreadContext(
  db: Db,
  sourceActivityId: number | null,
): Promise<string | null> {
  if (sourceActivityId == null) return null;
  const ancestors = await db.all<{ actorName: string | null; body: string | null }>(sql`
    WITH RECURSIVE chain AS (
      SELECT a.id, a.reply_to_id, a.actor_name, a.body, 0 AS depth
        FROM issue_activity a
       WHERE a.id = ${sourceActivityId}
      UNION ALL
      SELECT p.id, p.reply_to_id, p.actor_name, p.body, c.depth + 1
        FROM issue_activity p
        JOIN chain c ON p.id = c.reply_to_id
       WHERE c.depth < ${THREAD_CONTEXT_DEPTH}
    )
    SELECT actor_name AS actorName, body FROM chain WHERE depth > 0 ORDER BY depth DESC
  `);
  if (ancestors.length === 0) return null;
  return ancestors.map((a) => `${a.actorName ?? 'Unknown'}: ${a.body ?? ''}`).join('\n\n');
}

// A run canceled while it was in flight keeps that outcome: each of these writes only
// where the row is still 'pending'.

// `usage` is what the last model call of the run read and wrote. Null where the model
// reports none, which the run history shows as a dash.
export async function markRunSuccess(
  db: Db,
  id: number,
  output: string,
  usage: { inputTokens: number; outputTokens: number } | null,
): Promise<void> {
  await db
    .update(agentRun)
    .set({
      status: 'success',
      executionStartedAt: null,
      output,
      lastError: null,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      finishedAt: new Date(),
    })
    .where(and(eq(agentRun.id, id), eq(agentRun.status, 'pending')));
}

export async function scheduleRunRetry(
  db: Db,
  id: number,
  delayMs: number,
  error: string,
  now = Date.now(),
): Promise<void> {
  const delaySeconds = Math.max(1, Math.ceil(delayMs / 1000));
  await db
    .update(agentRun)
    .set({
      status: 'pending',
      executionStartedAt: null,
      nextAttemptAt: new Date(now + delaySeconds * 1000),
      lastError: error.slice(0, 500),
    })
    .where(and(eq(agentRun.id, id), eq(agentRun.status, 'pending')));
}

export async function markRunFailed(
  db: Db,
  id: number,
  error: string,
  output?: string,
): Promise<void> {
  await db
    .update(agentRun)
    .set({
      status: 'failed',
      executionStartedAt: null,
      lastError: error.slice(0, 500),
      ...(output ? { output } : {}),
      finishedAt: new Date(),
    })
    .where(and(eq(agentRun.id, id), eq(agentRun.status, 'pending')));
}

// Puts a claimed run back in the queue without spending the attempt, for a run the
// team has no free slot for or one held back by setRunAdmission. Waiting is not a failed
// attempt, and nothing has been recorded on the issue yet, so the run leaves no trace of
// having been picked up at all: a first claim's started_at goes too, so the waiting run
// holds no slot in countRunsAhead and can be canceled as not started.
export async function deferRun(
  db: Db,
  id: number,
  delaySeconds: number,
  now = Date.now(),
): Promise<void> {
  await db
    .update(agentRun)
    .set({
      executionStartedAt: null,
      attempts: sql`${agentRun.attempts} - 1`,
      startedAt: sql`CASE WHEN ${agentRun.attempts} = 1 THEN NULL ELSE ${agentRun.startedAt} END`,
      nextAttemptAt: new Date(now + delaySeconds * 1000),
    })
    .where(and(eq(agentRun.id, id), eq(agentRun.status, 'pending')));
}

export const executionState = sql<'queued' | 'running' | 'success' | 'failed' | 'canceled'>`
  CASE WHEN ${agentRun.status} <> 'pending' THEN ${agentRun.status}
    WHEN ${agentRun.executionStartedAt} IS NOT NULL AND ${agentRun.nextAttemptAt} > ${nowSql}
      THEN 'running'
    ELSE 'queued' END`;

export async function markRunExecuting(
  db: Db,
  id: number,
  attempts: number,
  now = Date.now(),
): Promise<boolean> {
  const rows = await db
    .update(agentRun)
    .set({ executionStartedAt: new Date(now) })
    .where(
      and(
        eq(agentRun.id, id),
        eq(agentRun.status, 'pending'),
        eq(agentRun.attempts, attempts),
        gt(agentRun.nextAttemptAt, new Date(now)),
      ),
    )
    .returning({ id: agentRun.id });
  return rows.length > 0;
}

export interface AgentRunRow {
  id: number;
  status: string;
  executionState: 'queued' | 'running' | 'success' | 'failed' | 'canceled';
  trigger: AgentRunTrigger;
  issueId: number | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  prompt: string;
  attempts: number;
  lastError: string | null;
  // What the run produced: the runtime's reply, or whatever the runner's command
  // printed. Null until the run finishes.
  output: string | null;
  contextTokens?: number;
  nextAttemptAt: string;
  createdAt: string;
}

// The size of a run's context as its DTO carries it. The field is left out where there
// is nothing to report: a run stored before the counts were recorded, and one whose
// agent reports none.
export function contextTokensOf(row: { inputTokens: number | null; outputTokens: number | null }): {
  contextTokens?: number;
} {
  if (row.inputTokens == null && row.outputTokens == null) return {};
  return { contextTokens: (row.inputTokens ?? 0) + (row.outputTokens ?? 0) };
}

export interface AgentRunPage {
  items: AgentRunRow[];
  // The id to pass as `before` to load the next page, or null when at the end.
  nextCursor: number | null;
}

// One page of an agent's runs, newest first. Keyset pagination by id (runs are
// id-monotonic): pass the previous page's nextCursor as `before`. limit is clamped to
// 1..50.
//
// An agent works in several projects of its team and a run carries the one it ran in,
// so `projectIds` bounds the page to the projects the reader may see. Omitted, it
// reads every project — only a caller who runs the team passes nothing.
export async function listAgentRuns(
  db: Db,
  agentId: number,
  opts: { before?: number; limit?: number; projectIds?: number[] } = {},
): Promise<AgentRunPage> {
  if (opts.projectIds?.length === 0) return { items: [], nextCursor: null };
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
  const rows = await db
    .select({
      id: agentRun.id,
      status: agentRun.status,
      executionState,
      trigger: agentRun.trigger,
      issueId: agentRun.issueId,
      prompt: agentRun.prompt,
      attempts: agentRun.attempts,
      lastError: agentRun.lastError,
      output: agentRun.output,
      inputTokens: agentRun.inputTokens,
      outputTokens: agentRun.outputTokens,
      nextAttemptAt: agentRun.nextAttemptAt,
      createdAt: agentRun.createdAt,
      issueSeq: issue.sequenceNumber,
      issueTitle: issue.title,
      projectKey: project.key,
    })
    .from(agentRun)
    .leftJoin(issue, eq(issue.id, agentRun.issueId))
    .leftJoin(project, eq(project.id, issue.projectId))
    .where(
      and(
        eq(agentRun.agentId, agentId),
        opts.projectIds ? inArray(agentRun.projectId, opts.projectIds) : undefined,
        opts.before ? lt(agentRun.id, opts.before) : undefined,
      ),
    )
    .orderBy(desc(agentRun.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map((r) => ({
      id: r.id,
      status: r.status,
      executionState: r.executionState,
      trigger: r.trigger as AgentRunTrigger,
      issueId: r.issueId,
      issueIdentifier: r.projectKey && r.issueSeq != null ? `${r.projectKey}-${r.issueSeq}` : null,
      issueTitle: r.issueTitle ?? null,
      prompt: r.prompt,
      attempts: r.attempts,
      lastError: r.lastError,
      output: r.output,
      ...contextTokensOf(r),
      nextAttemptAt: iso(r.nextAttemptAt),
      createdAt: iso(r.createdAt),
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}
