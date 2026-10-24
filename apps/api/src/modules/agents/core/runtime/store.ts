import type { D1Store } from '@mastra/cloudflare-d1';
import type { D1Like } from './bindings';

// The D1 store Mastra keeps its own tables in (`mastra_threads`, `mastra_messages`...), on
// the application database. Conversation memory (see memory.ts) is the only thing that uses
// it: the spans of agent runs are ours (`ai_spans`, see span-exporter.ts), since D1Store has
// no observability domain.

const stores = new WeakMap<object, Promise<D1Store>>();

// Mastra creates its tables on first use (CREATE TABLE IF NOT EXISTS), so an instance whose
// agents never ran has none of them yet: the store is initialised before it is handed out.
export function getStore(d1: D1Like): Promise<D1Store> {
  let ready = stores.get(d1);
  if (!ready) {
    ready = (async () => {
      const { D1Store } = await import('@mastra/cloudflare-d1');
      const store = new D1Store({
        id: 'ai-agent-memory',
        // workers-types' D1Database; ours is its structural subset.
        binding: d1 as never,
      });
      await store.init();
      return store;
    })();
    // A failed init is retried on the next call instead of poisoning the isolate.
    ready.catch(() => stores.delete(d1));
    stores.set(d1, ready);
  }
  return ready;
}
