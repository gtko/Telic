// The spans of internal agent runs (Mastra tracing), in a table of our own. Mastra's D1Store has
// no observability domain, so its `mastra_ai_spans` cannot exist on D1: the runtime writes this
// table through its own exporter (apps/api agents/core/runtime/span-exporter.ts). Mastra's
// own tables (threads, messages) are created by D1Store.init() and are not part of this schema.
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const aiSpans = sqliteTable(
  'ai_spans',
  {
    traceId: text('trace_id').notNull(),
    spanId: text('span_id').notNull(),
    parentSpanId: text('parent_span_id'),
    name: text('name').notNull(),
    spanType: text('span_type').notNull(),
    // Epoch milliseconds (UTC).
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    // JSON of the span error; null is a success. A run "failed" when its root has one.
    error: text('error'),

    // Trace-level columns lifted out of the root span's metadata (null on other spans), so
    // the dashboards filter on an index instead of scanning JSON.
    teamId: integer('team_id'),
    agentId: integer('agent_id'),
    projectId: integer('project_id'),
    runId: integer('run_id'),
    issueId: integer('issue_id'),
    scheduleId: integer('schedule_id'),
    userId: text('user_id'),
    trigger: text('trigger'),
    // The whole metadata JSON of the root span.
    metadata: text('metadata'),

    // Model-call columns lifted out of the attributes of `model_inference` spans.
    provider: text('provider'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheRead: integer('cache_read'),
    cacheWrite: integer('cache_write'),
    // The whole attributes JSON (parameters, finish reason, tool arguments...).
    attributes: text('attributes'),

    // Payloads: inline JSON up to the exporter's threshold, above it the JSON is an R2 object
    // named by the *_ref column and the *_json column stays null.
    inputJson: text('input_json'),
    outputJson: text('output_json'),
    inputRef: text('input_ref'),
    outputRef: text('output_ref'),
    inputBytes: integer('input_bytes'),
    outputBytes: integer('output_bytes'),
  },
  (t) => [
    primaryKey({ columns: [t.traceId, t.spanId] }),
    // The list of an agent's traces, newest first.
    index('ai_spans_agent_root')
      .on(t.agentId, sql`${t.startedAt} DESC`)
      .where(sql`${t.parentSpanId} IS NULL`),
    // Analytics: the roots of a team since a date.
    index('ai_spans_team_root')
      .on(t.teamId, t.startedAt)
      .where(sql`${t.parentSpanId} IS NULL`),
    // The traces of one queued run (retries share a run id).
    index('ai_spans_run_root')
      .on(t.runId, sql`${t.startedAt} DESC`)
      .where(sql`${t.parentSpanId} IS NULL`),
    index('ai_spans_issue_root')
      .on(t.issueId, sql`${t.startedAt} DESC`)
      .where(sql`${t.parentSpanId} IS NULL`),
    // Analytics model calls: join on the trace, filter on the type.
    index('ai_spans_type_trace').on(t.spanType, t.traceId),
    // Retention: the roots older than a date, then delete by trace.
    index('ai_spans_started')
      .on(t.startedAt)
      .where(sql`${t.parentSpanId} IS NULL`),
    // The detail view: every span of a trace.
    index('ai_spans_trace').on(t.traceId, t.startedAt),
  ],
);
