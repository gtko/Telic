import { type Db, agentRun, agentRunTrace, issue } from '@repo/db';
import { and, desc, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import type { AgUiEventBody } from '../model';

const MAX_EVENTS = 2000;
const MAX_BYTES = 1_000_000;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

export async function appendRunEvents(
  db: Db,
  agentId: number,
  runId: number,
  input: {
    attempt: number;
    offset: number;
    events: AgUiEventBody[];
    sessionId?: string;
  },
) {
  // Read, compute, then one conditional UPDATE: it only lands when the trace is still at
  // the offset that was read, so two reports of the same attempt cannot both append (the
  // loser gets the same 409 an out-of-order report gets). D1 has no row lock to take.
  const now = Date.now();
  const [run] = await db
    .select()
    .from(agentRun)
    .where(
      and(
        eq(agentRun.id, runId),
        eq(agentRun.agentId, agentId),
        eq(agentRun.status, 'pending'),
        eq(agentRun.attempts, input.attempt),
        isNotNull(agentRun.executionStartedAt),
        gt(agentRun.nextAttemptAt, new Date(now)),
      ),
    );
  if (!run) throw new HttpError(404, 'Active run attempt not found');
  await db.insert(agentRunTrace).values({ runId, attempt: input.attempt }).onConflictDoNothing();
  const key = and(eq(agentRunTrace.runId, runId), eq(agentRunTrace.attempt, input.attempt));
  const [trace] = await db.select().from(agentRunTrace).where(key);
  if (!trace) throw new HttpError(404, 'Active run attempt not found');
  if (input.offset < trace.nextOffset && input.offset + input.events.length <= trace.nextOffset) {
    return { nextOffset: trace.nextOffset, truncated: trace.truncated };
  }
  if (input.offset !== trace.nextOffset) throw new HttpError(409, 'Unexpected trace offset');
  if (trace.sessionId && input.sessionId && trace.sessionId !== input.sessionId) {
    throw new HttpError(409, 'Session is already bound to this attempt');
  }
  const events = trace.events as { event: AgUiEventBody; receivedAt: string }[];
  let bytes = byteLength(JSON.stringify(events));
  let truncated = trace.truncated;
  const receivedAt = new Date().toISOString();
  for (const event of input.events) {
    const stored = { event, receivedAt };
    const size = byteLength(JSON.stringify(stored)) + 1;
    if (truncated || events.length >= MAX_EVENTS || bytes + size > MAX_BYTES) {
      truncated = true;
      continue;
    }
    events.push(stored);
    bytes += size;
  }
  const nextOffset = input.offset + input.events.length;
  const written = await db
    .update(agentRunTrace)
    .set({
      events,
      nextOffset,
      truncated,
      sessionId: trace.sessionId ?? input.sessionId ?? null,
    })
    .where(and(key, eq(agentRunTrace.nextOffset, trace.nextOffset)))
    .returning({ runId: agentRunTrace.runId });
  if (written.length === 0) throw new HttpError(409, 'Unexpected trace offset');
  return { nextOffset, truncated };
}

export async function runProjectId(db: Db, runId: number) {
  const [row] = await db
    .select({ projectId: agentRun.projectId })
    .from(agentRun)
    .leftJoin(issue, eq(issue.id, agentRun.issueId))
    .where(
      and(
        eq(agentRun.id, runId),
        or(isNull(agentRun.issueId), eq(issue.projectId, agentRun.projectId)),
      ),
    );
  return row?.projectId;
}

export async function readRunTrace(db: Db, projectId: number, runId: number, attempt?: number) {
  const [row] = await db
    .select({ trace: agentRunTrace })
    .from(agentRunTrace)
    .innerJoin(agentRun, eq(agentRun.id, agentRunTrace.runId))
    .leftJoin(issue, eq(issue.id, agentRun.issueId))
    .where(
      and(
        eq(agentRun.id, runId),
        eq(agentRun.projectId, projectId),
        or(isNull(agentRun.issueId), eq(issue.projectId, projectId)),
        attempt == null ? undefined : eq(agentRunTrace.attempt, attempt),
      ),
    )
    .orderBy(desc(agentRunTrace.attempt))
    .limit(1);
  if (!row) return attempt == null ? null : undefined;
  const trace = row.trace;
  const [previous] = await db
    .select({ attempt: agentRunTrace.attempt })
    .from(agentRunTrace)
    .where(and(eq(agentRunTrace.runId, runId), lt(agentRunTrace.attempt, trace.attempt)))
    .orderBy(desc(agentRunTrace.attempt))
    .limit(1);
  return {
    attempt: trace.attempt,
    previousAttempt: previous?.attempt ?? null,
    sessionId: trace.sessionId,
    sessionUrl: trace.sessionId ? `codex://threads/${trace.sessionId}` : null,
    truncated: trace.truncated,
    events: trace.events,
  };
}
