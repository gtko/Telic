import { BaseExporter } from '@mastra/observability';
import { TracingEventType } from '@mastra/core/observability';
import type { TracingEvent } from '@mastra/core/observability';
import type { D1Like, D1PreparedLike, R2Like } from './bindings';

// The observability exporter that writes Mastra's spans into our `ai_spans` table (see
// packages/db schema/agent-spans.ts), the large payloads going to R2.
//
// Why not MastraStorageExporter: it writes through the observability domain of the store,
// and D1Store (@mastra/cloudflare-d1) has none, so every span would be dropped.
//
// One row per span, written when the span ENDS (SPAN_ENDED carries the whole span), buffered
// in memory and written in ONE D1 batch by `flush()`. The caller flushes in a `finally`, so
// the spans of a failed run are recorded too. A span still open when the isolate dies is
// lost, which is acceptable for queued runs: the agent_run row holds their state.

export interface SpanExporterConfig {
  db: D1Like;
  // Null when the deployment has no bucket: a payload above the threshold is then cut.
  payloads: R2Like | null;
  // JSON payloads above this many bytes go to R2.
  inlineMaxBytes: number;
}

const INSERT = `INSERT OR REPLACE INTO ai_spans (
  trace_id, span_id, parent_span_id, name, span_type, started_at, ended_at, error,
  team_id, agent_id, project_id, run_id, issue_id, schedule_id, user_id, trigger, metadata,
  provider, model, input_tokens, output_tokens, cache_read, cache_write, attributes,
  input_json, output_json, input_ref, output_ref, input_bytes, output_bytes
) VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?)`;

// D1 allows 1000 statements per invocation and 100 bound parameters per statement (30 here).
const FLUSH_CHUNK = 200;

const intOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const json = (v: unknown): string | null => {
  if (v === undefined) return null;
  try {
    return JSON.stringify(v) ?? null;
  } catch {
    return null;
  }
};
const bytesOf = (s: string) => new TextEncoder().encode(s).length;

type Payload = { inline: string | null; ref: string | null; bytes: number | null };

export class D1SpanExporter extends BaseExporter {
  name = 'telic-d1-spans';
  #cfg: SpanExporterConfig;
  #ended: TracingEvent[] = [];

  constructor(cfg: SpanExporterConfig) {
    super();
    this.#cfg = cfg;
  }

  protected async _exportTracingEvent(event: TracingEvent): Promise<void> {
    if (event.type === TracingEventType.SPAN_ENDED) this.#ended.push(event);
  }

  async flush(): Promise<void> {
    const events = this.#ended.splice(0);
    for (let i = 0; i < events.length; i += FLUSH_CHUNK) {
      const statements: D1PreparedLike[] = [];
      for (const event of events.slice(i, i + FLUSH_CHUNK)) statements.push(await this.#row(event));
      await this.#cfg.db.batch(statements);
    }
  }

  async shutdown(): Promise<void> {
    await this.flush();
  }

  async #payload(
    traceId: string,
    spanId: string,
    side: 'input' | 'output',
    value: unknown,
  ): Promise<Payload> {
    const text = json(value);
    if (text == null) return { inline: null, ref: null, bytes: null };
    const bytes = bytesOf(text);
    if (bytes <= this.#cfg.inlineMaxBytes) return { inline: text, ref: null, bytes };
    if (!this.#cfg.payloads) {
      // No bucket: keep a valid JSON document saying what was dropped rather than a cut one.
      return { inline: JSON.stringify({ truncated: true, bytes }), ref: null, bytes };
    }
    const ref = `spans/${traceId}/${spanId}.${side}.json`;
    await this.#cfg.payloads.put(ref, text);
    return { inline: null, ref, bytes };
  }

  async #row(event: TracingEvent): Promise<D1PreparedLike> {
    const s = event.exportedSpan;
    const root = s.parentSpanId == null;
    const meta = (root ? s.metadata : undefined) as Record<string, unknown> | undefined;
    const attrs = s.attributes as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    const usage = attrs?.usage as
      | { inputTokens?: number; outputTokens?: number; inputDetails?: Record<string, number> }
      | undefined;
    const input = await this.#payload(s.traceId, s.id, 'input', s.input);
    const output = await this.#payload(s.traceId, s.id, 'output', s.output);
    return this.#cfg.db
      .prepare(INSERT)
      .bind(
        s.traceId,
        s.id,
        s.parentSpanId ?? null,
        s.name,
        s.type,
        s.startTime.getTime(),
        s.endTime ? s.endTime.getTime() : null,
        json(s.errorInfo),
        intOrNull(meta?.teamId),
        intOrNull(meta?.agentId),
        intOrNull(meta?.projectId),
        intOrNull(meta?.runId),
        intOrNull(meta?.issueId),
        intOrNull(meta?.scheduleId),
        textOrNull(meta?.userId),
        textOrNull(meta?.trigger),
        root ? json(s.metadata) : null,
        textOrNull(attrs?.provider),
        textOrNull(attrs?.model),
        intOrNull(usage?.inputTokens),
        intOrNull(usage?.outputTokens),
        intOrNull(usage?.inputDetails?.cacheRead),
        intOrNull(usage?.inputDetails?.cacheWrite),
        json(attrs),
        input.inline,
        output.inline,
        input.ref,
        output.ref,
        input.bytes,
        output.bytes,
      );
  }
}
