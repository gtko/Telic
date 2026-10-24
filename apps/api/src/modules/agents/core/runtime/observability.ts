import { Mastra } from '@mastra/core';
import { Observability } from '@mastra/observability';
import { SPAN_INLINE_MAX_BYTES, type AgentRuntime } from './bindings';
import { getStore } from './store';
import { D1SpanExporter } from './span-exporter';

// Tracing of internal agent runs. Mastra emits a span for the run and one for every
// model call and tool call inside it, but only through a Mastra container: an agent
// built on its own writes nothing. So every agent a run builds is registered with the
// container held here, which carries the exporter that writes the spans into `ai_spans`.
//
// Nothing else of the container is used: the agents are built per run from their
// stored configuration, so none is registered as a named agent of it. One container per
// D1 binding and isolate; runs of one isolate share it, and each flushes it when done.

type Entry = { mastra: Mastra; exporter: D1SpanExporter };
const containers = new WeakMap<object, Promise<Entry>>();

function build(rt: AgentRuntime): Promise<Entry> {
  const exporter = new D1SpanExporter({
    db: rt.d1,
    payloads: rt.payloads,
    inlineMaxBytes: SPAN_INLINE_MAX_BYTES,
  });
  return getStore(rt.d1).then((storage) => ({
    exporter,
    mastra: new Mastra({
      storage,
      observability: new Observability({
        configs: { default: { serviceName: 'itsaplan-agents', exporters: [exporter] } },
      }),
    }),
  }));
}

function entryOf(rt: AgentRuntime): Promise<Entry> {
  let entry = containers.get(rt.d1);
  if (!entry) {
    entry = build(rt);
    containers.set(rt.d1, entry);
    // A failed build is retried by the next run rather than cached.
    entry.catch(() => containers.delete(rt.d1));
  }
  return entry;
}

export async function getMastra(rt: AgentRuntime): Promise<Mastra> {
  return (await entryOf(rt)).mastra;
}

// Writes the spans a run buffered. Called in a `finally`: a failed run's spans matter most,
// and a Worker isolate may be gone right after the run returns.
export async function flushSpans(rt: AgentRuntime): Promise<void> {
  await (await entryOf(rt)).exporter.flush();
}
