import { D1Store } from '@mastra/cloudflare-d1';
import type { D1Like } from './bindings';

// The D1 store Mastra keeps its own tables in (`mastra_threads`, `mastra_messages`...), on
// the application database. Conversation memory (see memory.ts) is the only thing that uses
// it: the spans of agent runs are ours (`ai_spans`, see span-exporter.ts), since D1Store has
// no observability domain.

type Entry = { store: D1Store; ready: Promise<void> };
const stores = new WeakMap<object, Entry>();

function entryOf(d1: D1Like): Entry {
  let entry = stores.get(d1);
  if (!entry) {
    const store = new D1Store({
      id: 'ai-agent-memory',
      // workers-types' D1Database; ours is its structural subset.
      binding: d1 as never,
    });
    entry = { store, ready: store.init() };
    // A failed init is retried on the next call instead of poisoning the isolate.
    entry.ready.catch(() => stores.delete(d1));
    stores.set(d1, entry);
  }
  return entry;
}

// Mastra creates its tables on first use (CREATE TABLE IF NOT EXISTS), so an instance whose
// agents never ran has none of them yet: the store is initialised before it is handed out.
export async function getStore(d1: D1Like): Promise<D1Store> {
  const entry = entryOf(d1);
  await entry.ready;
  return entry.store;
}
