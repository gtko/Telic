import { aiSpans, type Db } from '@repo/db';
import { and, asc, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AgentRuntime } from './bindings';
import { toIso } from '../helpers/dates';
import type { AgentRunTrigger } from '../../model';

// Read side of the traces the span exporter writes (see span-exporter.ts): one trace per
// run of an internal agent, holding a span for the run and one for every model call and
// tool call inside it. The spans carry no foreign keys of ours, so a trace is found by the
// columns the exporter lifted out of the root span's metadata (agent_id, run_id, user_id...),
// which are indexed: filtering on them is a lookup, not a JSON scan.

// The trace of one run, as the list shows it.
export interface TraceSummary {
  traceId: string;
  name: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  projectId: number | null;
  // The queued run this traced, and what triggered it. Null for a trace of the test
  // chat, which is queued nowhere.
  runId: number | null;
  trigger: AgentRunTrigger | null;
  issueId: number | null;
}

// One step of a trace: the run itself, a model call, or a tool call.
export interface TraceSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  type: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  error: unknown;
  // What the span itself reports: the model and its token counts for a model call,
  // the arguments for a tool call.
  attributes: unknown;
}

type SpanRow = typeof aiSpans.$inferSelect;

function parseJson(text: string | null): unknown {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// A span holds no status of its own: it is derived from its error and its end.
function statusOf(span: Pick<SpanRow, 'error' | 'endedAt'>): string {
  if (span.error != null) return 'error';
  return span.endedAt != null ? 'success' : 'running';
}

function toSummary(span: SpanRow): TraceSummary {
  return {
    traceId: span.traceId,
    name: span.name,
    status: statusOf(span),
    startedAt: toIso(new Date(span.startedAt)),
    endedAt: span.endedAt != null ? toIso(new Date(span.endedAt)) : null,
    durationMs: span.endedAt != null ? span.endedAt - span.startedAt : null,
    projectId: span.projectId,
    runId: span.runId,
    trigger: span.trigger as AgentRunTrigger | null,
    issueId: span.issueId,
  };
}

// The roots of an agent's traces the viewer may read. A chat run carries the member who
// chatted, and its spans hold what they wrote, so like the chat thread itself its trace is
// theirs alone: the team's owner reads it no more than anyone else.
function readableRoots(agentId: number, viewerId: string, extra: (SQL | undefined)[] = []) {
  return and(
    isNull(aiSpans.parentSpanId),
    eq(aiSpans.agentId, agentId),
    or(isNull(aiSpans.userId), eq(aiSpans.userId, viewerId)),
    ...extra,
  );
}

// One page of the agent's traces the viewer may read, newest first, optionally only
// those of one project.
export async function listAgentTraces(
  db: Db,
  agentId: number,
  viewerId: string,
  opts: { projectId?: number; limit: number; offset: number },
): Promise<{ items: TraceSummary[]; total: number }> {
  const where = readableRoots(agentId, viewerId, [
    opts.projectId != null ? eq(aiSpans.projectId, opts.projectId) : undefined,
  ]);
  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(aiSpans)
      .where(where)
      .orderBy(desc(aiSpans.startedAt))
      .limit(opts.limit)
      .offset(opts.offset),
    db
      .select({ total: sql<number>`count(*)` })
      .from(aiSpans)
      .where(where),
  ]);
  return { items: rows.map(toSummary), total: counted[0]?.total ?? 0 };
}

// A payload is inline JSON, or the key of an R2 object when it was too large for a row.
// A deployment without the bucket (or an object that is gone) reads as a marker rather
// than failing the whole trace.
async function payloadOf(
  rt: AgentRuntime,
  inline: string | null,
  ref: string | null,
  bytes: number | null,
): Promise<unknown> {
  if (ref == null) return parseJson(inline);
  const object = await rt.payloads?.get(ref).catch(() => null);
  if (!object) return { truncated: true, bytes };
  return parseJson(await object.text());
}

// Every span of one trace, oldest first, or null when the trace is not this agent's or
// is another person's chat — either reads as missing rather than as refused.
export async function getAgentTrace(
  rt: AgentRuntime,
  agentId: number,
  traceId: string,
  viewerId: string,
): Promise<{ trace: TraceSummary; spans: TraceSpan[] } | null> {
  const rows = await rt.db
    .select()
    .from(aiSpans)
    .where(eq(aiSpans.traceId, traceId))
    .orderBy(asc(aiSpans.startedAt), asc(aiSpans.spanId));
  const root = rows.find((span) => span.parentSpanId == null);
  if (!root || root.agentId !== agentId) return null;
  if (root.userId != null && root.userId !== viewerId) return null;
  const spans = await Promise.all(
    rows.map(async (span) => ({
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      type: span.spanType,
      status: statusOf(span),
      startedAt: toIso(new Date(span.startedAt)),
      endedAt: span.endedAt != null ? toIso(new Date(span.endedAt)) : null,
      durationMs: span.endedAt != null ? span.endedAt - span.startedAt : null,
      input: await payloadOf(rt, span.inputJson, span.inputRef, span.inputBytes),
      output: await payloadOf(rt, span.outputJson, span.outputRef, span.outputBytes),
      error: parseJson(span.error),
      attributes: parseJson(span.attributes),
    })),
  );
  return { trace: toSummary(root), spans };
}

// Retries share a queued run id. Each trace links to the previous recorded attempt.
export async function getRunTrace(
  rt: AgentRuntime,
  agentId: number,
  runId: number,
  projectId: number,
  issueId: number,
  viewerId: string,
  traceId?: string,
) {
  const where = readableRoots(agentId, viewerId, [
    eq(aiSpans.runId, runId),
    eq(aiSpans.projectId, projectId),
    eq(aiSpans.issueId, issueId),
  ]);
  const [latest] = await rt.db
    .select({ traceId: aiSpans.traceId, startedAt: aiSpans.startedAt })
    .from(aiSpans)
    .where(and(where, traceId == null ? undefined : eq(aiSpans.traceId, traceId)))
    .orderBy(desc(aiSpans.startedAt), desc(aiSpans.traceId))
    .limit(1);
  if (!latest) return traceId == null ? null : undefined;
  const detail = await getAgentTrace(rt, agentId, latest.traceId, viewerId);
  if (!detail) return traceId == null ? null : undefined;
  const [older] = await rt.db
    .select({ traceId: aiSpans.traceId })
    .from(aiSpans)
    .where(
      and(
        where,
        or(
          lt(aiSpans.startedAt, latest.startedAt),
          and(eq(aiSpans.startedAt, latest.startedAt), lt(aiSpans.traceId, latest.traceId)),
        ),
      ),
    )
    .orderBy(desc(aiSpans.startedAt), desc(aiSpans.traceId))
    .limit(1);
  return { ...detail, previousTraceId: older?.traceId ?? null };
}
